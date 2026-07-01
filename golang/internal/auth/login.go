// Package auth handles QR code login and credential persistence.
package auth

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/corespeed-io/wechatbot/golang/internal/protocol"
)

// Credentials holds bot authentication data.
type Credentials struct {
	Token     string `json:"token"`
	BaseURL   string `json:"baseUrl"`
	AccountID string `json:"accountId"`
	UserID    string `json:"userId"`
	SavedAt   string `json:"savedAt,omitempty"`
}

// DefaultCredPath returns ~/.wechatbot/credentials.json
func DefaultCredPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".wechatbot", "credentials.json")
}

// LoadCredentials loads stored credentials from disk.
func LoadCredentials(path string) (*Credentials, error) {
	if path == "" {
		path = DefaultCredPath()
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, err
	}
	return &creds, nil
}

// SaveCredentials persists credentials to disk with 0600 permissions.
func SaveCredentials(creds *Credentials, path string) error {
	if path == "" {
		path = DefaultCredPath()
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(creds, "", "  ")
	return os.WriteFile(path, append(data, '\n'), 0600)
}

// ClearCredentials removes stored credentials.
func ClearCredentials(path string) error {
	if path == "" {
		path = DefaultCredPath()
	}
	return os.Remove(path)
}

// LoginOptions configures the login flow.
type LoginOptions struct {
	BaseURL   string
	CredPath  string
	Force     bool
	OnQRURL   func(url string)
	OnScanned func()
	OnExpired func()
	// OnVerifyCode is called when the server requires a pairing code (the
	// digits shown in WeChat on the user's phone). isRetry is true when a
	// previously submitted code was rejected. Defaults to a stdin prompt.
	OnVerifyCode func(isRetry bool) (string, error)
}

// readVerifyCode is the default pairing-code prompt: read a line from stdin.
func readVerifyCode(isRetry bool) (string, error) {
	prompt := "Enter the pairing code shown in WeChat on your phone: "
	if isRetry {
		prompt = "Code mismatch — enter the pairing code shown in WeChat again: "
	}
	fmt.Fprint(os.Stderr, prompt)
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

const (
	maxQRRefreshCount = 3
	fixedQRBaseURL    = "https://ilinkai.weixin.qq.com"
)

// Login performs QR code login, returning credentials.
// If stored credentials exist and Force is false, returns them directly.
// Handles IDC redirect (scaned_but_redirect) and limits QR refreshes.
func Login(ctx context.Context, client *protocol.Client, opts LoginOptions) (*Credentials, error) {
	baseURL := opts.BaseURL
	if baseURL == "" {
		baseURL = protocol.DefaultBaseURL
	}

	stored, _ := LoadCredentials(opts.CredPath)
	if !opts.Force && stored != nil {
		return stored, nil
	}

	// Send known local tokens so the server can answer binded_redirect
	// instead of issuing a duplicate session for an already-bound bot.
	var localTokenList []string
	if stored != nil && stored.Token != "" {
		localTokenList = []string{stored.Token}
	}

	qrRefreshCount := 0
	for {
		qrRefreshCount++
		if qrRefreshCount > maxQRRefreshCount {
			return nil, fmt.Errorf("QR code expired %d times — login aborted", maxQRRefreshCount)
		}

		qr, err := client.GetQRCode(ctx, fixedQRBaseURL, localTokenList)
		if err != nil {
			return nil, fmt.Errorf("get QR code: %w", err)
		}

		if opts.OnQRURL != nil {
			opts.OnQRURL(qr.QRCodeImgURL)
		} else {
			fmt.Fprintf(os.Stderr, "[wechatbot] Scan this URL in WeChat: %s\n", qr.QRCodeImgURL)
		}

		lastStatus := ""
		currentPollBaseURL := fixedQRBaseURL
		// Pairing code awaiting server verification (pair-code login flow)
		pendingVerifyCode := ""
		for {
			status, err := client.PollQRStatus(ctx, currentPollBaseURL, qr.QRCode, pendingVerifyCode)
			if err != nil {
				return nil, fmt.Errorf("poll QR status: %w", err)
			}

			if status.Status != lastStatus {
				lastStatus = status.Status
				switch status.Status {
				case "scaned":
					// A pending pairing code that leads back to scaned was accepted
					pendingVerifyCode = ""
					if opts.OnScanned != nil {
						opts.OnScanned()
					} else {
						fmt.Fprintln(os.Stderr, "[wechatbot] QR scanned — confirm in WeChat")
					}
				case "expired":
					if opts.OnExpired != nil {
						opts.OnExpired()
					} else {
						fmt.Fprintln(os.Stderr, "[wechatbot] QR expired — requesting new one")
					}
				case "confirmed":
					fmt.Fprintln(os.Stderr, "[wechatbot] Login confirmed")
				}
			}

			if status.Status == "confirmed" {
				if status.BotToken == "" || status.BotID == "" || status.UserID == "" {
					return nil, fmt.Errorf("login confirmed but missing credentials")
				}
				resolvedBase := baseURL
				if status.BaseURL != "" {
					resolvedBase = status.BaseURL
				}
				creds := &Credentials{
					Token:     status.BotToken,
					BaseURL:   resolvedBase,
					AccountID: status.BotID,
					UserID:    status.UserID,
					SavedAt:   time.Now().UTC().Format(time.RFC3339),
				}
				if err := SaveCredentials(creds, opts.CredPath); err != nil {
					fmt.Fprintf(os.Stderr, "[wechatbot] Warning: could not save credentials: %v\n", err)
				}
				return creds, nil
			}

			// Pair-code challenge: ask the user for the digits shown in WeChat
			if status.Status == "need_verifycode" {
				isRetry := pendingVerifyCode != ""
				prompt := opts.OnVerifyCode
				if prompt == nil {
					prompt = readVerifyCode
				}
				code, err := prompt(isRetry)
				if err != nil {
					return nil, fmt.Errorf("read pairing code: %w", err)
				}
				pendingVerifyCode = code
				continue // Re-poll immediately with the code attached
			}

			// Too many wrong pairing codes: server blocked this QR — get a new one
			if status.Status == "verify_code_blocked" {
				fmt.Fprintln(os.Stderr, "[wechatbot] Pairing code blocked after repeated mismatches — requesting new QR")
				pendingVerifyCode = ""
				break // Outer loop requests a new QR (counts toward refresh limit)
			}

			// Already bound to this client: reuse existing local credentials
			if status.Status == "binded_redirect" {
				if stored != nil {
					fmt.Fprintln(os.Stderr, "[wechatbot] Bot already bound — reusing stored credentials")
					return stored, nil
				}
				return nil, fmt.Errorf("server reports this bot is already bound to this client (binded_redirect), but no local credentials were found")
			}

			// Handle IDC redirect
			if status.Status == "scaned_but_redirect" {
				if status.RedirectHost != "" {
					currentPollBaseURL = "https://" + status.RedirectHost
					fmt.Fprintf(os.Stderr, "[wechatbot] IDC redirect → %s\n", status.RedirectHost)
				}
				time.Sleep(2 * time.Second)
				continue
			}

			if status.Status == "expired" {
				break // Outer loop gets a new QR
			}

			time.Sleep(2 * time.Second)
		}
	}
}
