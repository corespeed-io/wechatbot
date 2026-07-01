// Package protocol implements the raw iLink Bot API HTTP calls.
package protocol

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultBaseURL    = "https://ilinkai.weixin.qq.com"
	CDNBaseURL        = "https://novac2c.cdn.weixin.qq.com/c2c"
	ChannelVersion    = "0.1.0"
	// iLink-App-Id header value.
	iLinkAppID        = "bot"
	// iLink-App-ClientVersion header value (0x00MMNNPP for 0.1.0 = 256).
	iLinkClientVer    = "256"
)

// APIError is returned when the iLink API returns a non-zero ret or HTTP error.
type APIError struct {
	Message    string
	HTTPStatus int
	ErrCode    int
}

func (e *APIError) Error() string {
	return fmt.Sprintf("ilink api: %s (http=%d, errcode=%d)", e.Message, e.HTTPStatus, e.ErrCode)
}

// IsSessionExpired returns true if this error indicates session timeout.
func (e *APIError) IsSessionExpired() bool {
	return e.ErrCode == -14
}

// RandomWechatUIN generates the X-WECHAT-UIN header value.
func RandomWechatUIN() string {
	var buf [4]byte
	rand.Read(buf[:])
	val := binary.BigEndian.Uint32(buf[:])
	return base64.StdEncoding.EncodeToString([]byte(strconv.FormatUint(uint64(val), 10)))
}

// CommonHeaders returns headers included in both GET and POST requests.
func CommonHeaders() http.Header {
	h := http.Header{}
	h.Set("iLink-App-Id", iLinkAppID)
	h.Set("iLink-App-ClientVersion", iLinkClientVer)
	return h
}

// AuthHeaders returns the standard iLink POST headers.
func AuthHeaders(token string) http.Header {
	h := CommonHeaders()
	h.Set("Content-Type", "application/json")
	h.Set("AuthorizationType", "ilink_bot_token")
	h.Set("Authorization", "Bearer "+token)
	h.Set("X-WECHAT-UIN", RandomWechatUIN())
	return h
}

// DefaultBotAgent is used when no bot_agent is configured or the configured
// value is invalid.
const DefaultBotAgent = "WeChatBot/" + ChannelVersion

// Maximum length (bytes) of the sanitized bot_agent string.
const botAgentMaxLen = 256

// UA-style grammar (matches openclaw-weixin):
//
//	bot_agent = product *( SP product )
//	product   = name "/" version [ SP "(" comment ")" ]
var botAgentRe = regexp.MustCompile(
	`^[A-Za-z0-9_.\-]{1,32}/[A-Za-z0-9_.+\-]{1,32}( \([\x20-\x27\x2A-\x7E]{1,64}\))?` +
		`( [A-Za-z0-9_.\-]{1,32}/[A-Za-z0-9_.+\-]{1,32}( \([\x20-\x27\x2A-\x7E]{1,64}\))?)*$`,
)

// SanitizeBotAgent validates a user-supplied bot_agent into a wire-safe string.
//
// Unlike upstream openclaw-weixin (which salvages the valid tokens out of a
// partially invalid string), any invalid input falls back to DefaultBotAgent
// wholesale — simpler and just as safe on the wire.
func SanitizeBotAgent(raw string) string {
	normalized := strings.Join(strings.Fields(raw), " ")
	if normalized == "" || len(normalized) > botAgentMaxLen || !botAgentRe.MatchString(normalized) {
		return DefaultBotAgent
	}
	return normalized
}

// Client wraps HTTP calls to the iLink API.
type Client struct {
	HTTP *http.Client
	// BotAgent identifies the app driving this bot; sent as base_info.bot_agent.
	// Empty means DefaultBotAgent.
	BotAgent string
}

// NewClient creates a protocol client with sensible defaults.
func NewClient() *Client {
	return &Client{
		HTTP: &http.Client{Timeout: 45 * time.Second},
	}
}

func (c *Client) baseInfo() map[string]string {
	agent := c.BotAgent
	if agent == "" {
		agent = DefaultBotAgent
	}
	return map[string]string{"channel_version": ChannelVersion, "bot_agent": agent}
}

// QRCodeResponse from get_bot_qrcode.
type QRCodeResponse struct {
	QRCode         string `json:"qrcode"`
	QRCodeImgURL   string `json:"qrcode_img_content"`
}

// QRStatusResponse from get_qrcode_status.
type QRStatusResponse struct {
	Status       string `json:"status"` // wait, scaned, confirmed, expired, scaned_but_redirect, binded_redirect, need_verifycode, verify_code_blocked
	BotToken     string `json:"bot_token,omitempty"`
	BotID        string `json:"ilink_bot_id,omitempty"`
	UserID       string `json:"ilink_user_id,omitempty"`
	BaseURL      string `json:"baseurl,omitempty"`
	RedirectHost string `json:"redirect_host,omitempty"` // set when status is scaned_but_redirect
}

// GetUpdatesResponse from getupdates.
type GetUpdatesResponse struct {
	Ret           int               `json:"ret"`
	Msgs          []json.RawMessage `json:"msgs"`
	GetUpdatesBuf string            `json:"get_updates_buf"`
	ErrCode       int               `json:"errcode,omitempty"`
	ErrMsg        string            `json:"errmsg,omitempty"`
}

// GetConfigResponse from getconfig.
type GetConfigResponse struct {
	TypingTicket string `json:"typing_ticket,omitempty"`
	Ret          int    `json:"ret,omitempty"`
}

// GetQRCode requests a new QR code for login.
//
// localTokenList carries up to 10 known local bot tokens (newest first) so
// the server can answer binded_redirect for an already-bound bot instead of
// issuing a duplicate session.
func (c *Client) GetQRCode(ctx context.Context, baseURL string, localTokenList []string) (*QRCodeResponse, error) {
	if localTokenList == nil {
		localTokenList = []string{}
	}
	body, _ := json.Marshal(map[string]interface{}{"local_token_list": localTokenList})
	u := baseURL + "/ilink/bot/get_bot_qrcode?bot_type=3"
	req, _ := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(body))
	for k, v := range CommonHeaders() {
		req.Header[k] = v
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get_bot_qrcode: %w", err)
	}
	defer resp.Body.Close()
	var result QRCodeResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("get_bot_qrcode decode: %w", err)
	}
	return &result, nil
}

// PollQRStatus polls the QR code scan status.
//
// verifyCode submits a pairing code after the server answered need_verifycode
// (the digits shown in WeChat on the user's phone). Pass "" when none.
func (c *Client) PollQRStatus(ctx context.Context, baseURL, qrcode, verifyCode string) (*QRStatusResponse, error) {
	u := baseURL + "/ilink/bot/get_qrcode_status?qrcode=" + url.QueryEscape(qrcode)
	if verifyCode != "" {
		u += "&verify_code=" + url.QueryEscape(verifyCode)
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	for k, v := range CommonHeaders() {
		req.Header[k] = v
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result QRStatusResponse
	json.NewDecoder(resp.Body).Decode(&result)
	return &result, nil
}

// apiPost sends a POST to the iLink API and parses the response.
func (c *Client) apiPost(ctx context.Context, baseURL, endpoint, token string, body interface{}, timeout time.Duration) (json.RawMessage, error) {
	data, _ := json.Marshal(body)
	u := baseURL + endpoint
	httpCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, _ := http.NewRequestWithContext(httpCtx, "POST", u, bytes.NewReader(data))
	for k, v := range AuthHeaders(token) {
		req.Header[k] = v
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", endpoint, err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, &APIError{Message: string(raw), HTTPStatus: resp.StatusCode}
	}

	// Check ret != 0 or errcode != 0
	var check struct {
		Ret     int    `json:"ret"`
		ErrCode int    `json:"errcode"`
		ErrMsg  string `json:"errmsg"`
	}
	json.Unmarshal(raw, &check)
	if check.Ret != 0 || check.ErrCode != 0 {
		code := check.ErrCode
		if code == 0 {
			code = check.Ret
		}
		msg := check.ErrMsg
		if msg == "" {
			msg = fmt.Sprintf("ret=%d", check.Ret)
		}
		return nil, &APIError{Message: msg, HTTPStatus: resp.StatusCode, ErrCode: code}
	}

	return json.RawMessage(raw), nil
}

// GetUpdates performs a long-poll for new messages.
func (c *Client) GetUpdates(ctx context.Context, baseURL, token, cursor string) (*GetUpdatesResponse, error) {
	body := map[string]interface{}{
		"get_updates_buf": cursor,
		"base_info":       c.baseInfo(),
	}
	raw, err := c.apiPost(ctx, baseURL, "/ilink/bot/getupdates", token, body, 45*time.Second)
	if err != nil {
		return nil, err
	}
	var result GetUpdatesResponse
	json.Unmarshal(raw, &result)
	return &result, nil
}

// SendMessage sends a message through the iLink API.
func (c *Client) SendMessage(ctx context.Context, baseURL, token string, msg interface{}) error {
	body := map[string]interface{}{
		"msg":       msg,
		"base_info": c.baseInfo(),
	}
	_, err := c.apiPost(ctx, baseURL, "/ilink/bot/sendmessage", token, body, 15*time.Second)
	return err
}

// GetConfig gets the typing ticket for a user.
func (c *Client) GetConfig(ctx context.Context, baseURL, token, userID, contextToken string) (*GetConfigResponse, error) {
	body := map[string]interface{}{
		"ilink_user_id": userID,
		"context_token": contextToken,
		"base_info":     c.baseInfo(),
	}
	raw, err := c.apiPost(ctx, baseURL, "/ilink/bot/getconfig", token, body, 15*time.Second)
	if err != nil {
		return nil, err
	}
	var result GetConfigResponse
	json.Unmarshal(raw, &result)
	return &result, nil
}

// SendTyping sends or cancels the typing indicator.
func (c *Client) SendTyping(ctx context.Context, baseURL, token, userID, ticket string, status int) error {
	body := map[string]interface{}{
		"ilink_user_id":  userID,
		"typing_ticket":  ticket,
		"status":         status,
		"base_info":      c.baseInfo(),
	}
	_, err := c.apiPost(ctx, baseURL, "/ilink/bot/sendtyping", token, body, 15*time.Second)
	return err
}

// GetUploadURLRequest holds parameters for getuploadurl.
type GetUploadURLRequest struct {
	FileKey       string `json:"filekey"`
	MediaType     int    `json:"media_type"`
	ToUserID      string `json:"to_user_id"`
	RawSize       int    `json:"rawsize"`
	RawFileMD5    string `json:"rawfilemd5"`
	FileSize      int    `json:"filesize"`
	ThumbRawSize  int    `json:"thumb_rawsize,omitempty"`
	ThumbFileMD5  string `json:"thumb_rawfilemd5,omitempty"`
	ThumbFileSize int    `json:"thumb_filesize,omitempty"`
	NoNeedThumb   bool   `json:"no_need_thumb,omitempty"`
	AESKey        string `json:"aeskey,omitempty"`
}

// GetUploadURLResponse from getuploadurl.
type GetUploadURLResponse struct {
	UploadParam      string `json:"upload_param"`
	ThumbUploadParam string `json:"thumb_upload_param,omitempty"`
	// Complete upload URL returned by server; when set, use directly instead of building from UploadParam.
	UploadFullURL    string `json:"upload_full_url,omitempty"`
}

// GetUploadURL requests an upload URL for CDN media upload.
func (c *Client) GetUploadURL(ctx context.Context, baseURL, token string, req GetUploadURLRequest) (*GetUploadURLResponse, error) {
	body := map[string]interface{}{
		"filekey":        req.FileKey,
		"media_type":     req.MediaType,
		"to_user_id":     req.ToUserID,
		"rawsize":        req.RawSize,
		"rawfilemd5":     req.RawFileMD5,
		"filesize":       req.FileSize,
		"no_need_thumb":  req.NoNeedThumb,
		"aeskey":         req.AESKey,
		"base_info":      c.baseInfo(),
	}
	raw, err := c.apiPost(ctx, baseURL, "/ilink/bot/getuploadurl", token, body, 15*time.Second)
	if err != nil {
		return nil, err
	}
	var result GetUploadURLResponse
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("getuploadurl decode: %w", err)
	}
	return &result, nil
}

// UploadToCDN uploads encrypted bytes to the CDN with retry (up to 3 attempts).
// Returns the download encrypted_query_param from the x-encrypted-param header.
// Client errors (4xx) abort immediately; server errors retry.
func (c *Client) UploadToCDN(ctx context.Context, cdnURL string, ciphertext []byte) (string, error) {
	const maxRetries = 3
	var lastErr error

	for attempt := 1; attempt <= maxRetries; attempt++ {
		req, _ := http.NewRequestWithContext(ctx, "POST", cdnURL, bytes.NewReader(ciphertext))
		req.Header.Set("Content-Type", "application/octet-stream")

		resp, err := c.HTTP.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("CDN upload attempt %d: %w", attempt, err)
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			errMsg := resp.Header.Get("x-error-message")
			if errMsg == "" {
				errMsg = fmt.Sprintf("HTTP %d", resp.StatusCode)
			}
			return "", fmt.Errorf("CDN upload client error %d: %s", resp.StatusCode, errMsg)
		}
		if resp.StatusCode != 200 {
			errMsg := resp.Header.Get("x-error-message")
			lastErr = fmt.Errorf("CDN upload server error %d: %s", resp.StatusCode, errMsg)
			continue
		}

		downloadParam := resp.Header.Get("x-encrypted-param")
		if downloadParam == "" {
			lastErr = fmt.Errorf("CDN upload response missing x-encrypted-param header")
			continue
		}
		return downloadParam, nil
	}
	return "", fmt.Errorf("CDN upload failed after %d attempts: %w", maxRetries, lastErr)
}

// BuildCDNUploadURL constructs a CDN upload URL from params.
func BuildCDNUploadURL(cdnBaseURL, uploadParam, filekey string) string {
	return cdnBaseURL + "/upload?encrypted_query_param=" + url.QueryEscape(uploadParam) + "&filekey=" + url.QueryEscape(filekey)
}

// BuildTextMessage creates a text message payload.
func BuildTextMessage(userID, contextToken, text string) map[string]interface{} {
	return map[string]interface{}{
		"from_user_id":  "",
		"to_user_id":    userID,
		"client_id":     newUUID(),
		"message_type":  2,
		"message_state": 2,
		"context_token": contextToken,
		"item_list": []map[string]interface{}{
			{"type": 1, "text_item": map[string]string{"text": text}},
		},
	}
}

// BuildMediaMessage creates a media message payload.
func BuildMediaMessage(userID, contextToken string, itemList []map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"from_user_id":  "",
		"to_user_id":    userID,
		"client_id":     newUUID(),
		"message_type":  2,
		"message_state": 2,
		"context_token": contextToken,
		"item_list":     itemList,
	}
}

func newUUID() string {
	// Simple UUID v4
	var buf [16]byte
	rand.Read(buf[:])
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}
