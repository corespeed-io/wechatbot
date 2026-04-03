package wechatbot

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/corespeed-io/wechatbot/golang/internal/auth"
	"github.com/corespeed-io/wechatbot/golang/internal/crypto"
	"github.com/corespeed-io/wechatbot/golang/internal/protocol"
)

// MessageHandler is called for each incoming user message.
type MessageHandler func(msg *IncomingMessage)

// Options configures a Bot instance.
type Options struct {
	BaseURL      string
	CredPath     string
	LogLevel     string // "debug", "info", "warn", "error", "silent"
	OnQRURL      func(url string)
	OnScanned    func()
	OnExpired    func()
	OnError      func(err error)
}

// Bot is the main WeChat bot client.
type Bot struct {
	opts          Options
	client        *protocol.Client
	creds         *auth.Credentials
	handlers      []MessageHandler
	contextTokens sync.Map // map[string]string
	cursor        string
	stopped       bool
	mu            sync.Mutex
	cancelPoll    context.CancelFunc
}

// New creates a new Bot instance.
func New(opts ...Options) *Bot {
	var o Options
	if len(opts) > 0 {
		o = opts[0]
	}
	if o.BaseURL == "" {
		o.BaseURL = protocol.DefaultBaseURL
	}
	return &Bot{
		opts:   o,
		client: protocol.NewClient(),
	}
}

// Login performs QR code login or loads stored credentials.
func (b *Bot) Login(ctx context.Context, force bool) (*Credentials, error) {
	creds, err := auth.Login(ctx, b.client, auth.LoginOptions{
		BaseURL:   b.opts.BaseURL,
		CredPath:  b.opts.CredPath,
		Force:     force,
		OnQRURL:   b.opts.OnQRURL,
		OnScanned: b.opts.OnScanned,
		OnExpired: b.opts.OnExpired,
	})
	if err != nil {
		return nil, err
	}

	b.mu.Lock()
	b.creds = creds
	b.opts.BaseURL = creds.BaseURL
	b.mu.Unlock()

	b.log("info", "Logged in as %s", creds.UserID)

	return &Credentials{
		Token:     creds.Token,
		BaseURL:   creds.BaseURL,
		AccountID: creds.AccountID,
		UserID:    creds.UserID,
		SavedAt:   creds.SavedAt,
	}, nil
}

// OnMessage registers a message handler.
func (b *Bot) OnMessage(handler MessageHandler) {
	b.handlers = append(b.handlers, handler)
}

// Reply sends a text reply to an incoming message.
func (b *Bot) Reply(ctx context.Context, msg *IncomingMessage, text string) error {
	b.contextTokens.Store(msg.UserID, msg.ContextToken)
	return b.sendText(ctx, msg.UserID, text, msg.ContextToken)
}

// Send sends a text message to a user (requires prior context_token).
func (b *Bot) Send(ctx context.Context, userID, text string) error {
	ct, ok := b.contextTokens.Load(userID)
	if !ok {
		return fmt.Errorf("no context_token for user %s", userID)
	}
	return b.sendText(ctx, userID, text, ct.(string))
}

// SendTyping shows the "typing..." indicator.
func (b *Bot) SendTyping(ctx context.Context, userID string) error {
	ct, ok := b.contextTokens.Load(userID)
	if !ok {
		return fmt.Errorf("no context_token for user %s", userID)
	}
	creds := b.getCreds()
	config, err := b.client.GetConfig(ctx, creds.BaseURL, creds.Token, userID, ct.(string))
	if err != nil {
		return err
	}
	if config.TypingTicket == "" {
		return nil
	}
	return b.client.SendTyping(ctx, creds.BaseURL, creds.Token, userID, config.TypingTicket, 1)
}

// StopTyping cancels the "typing..." indicator.
func (b *Bot) StopTyping(ctx context.Context, userID string) error {
	ct, ok := b.contextTokens.Load(userID)
	if !ok {
		return nil
	}
	creds := b.getCreds()
	config, err := b.client.GetConfig(ctx, creds.BaseURL, creds.Token, userID, ct.(string))
	if err != nil {
		return err
	}
	if config.TypingTicket == "" {
		return nil
	}
	return b.client.SendTyping(ctx, creds.BaseURL, creds.Token, userID, config.TypingTicket, 2)
}

// SendContent describes what to send. Use one of:
//   - SendText("Hello!")
//   - SendImage(data)
//   - SendVideo(data)
//   - SendFile(data, "report.pdf")
type SendContent struct {
	Text     string
	Image    []byte
	Video    []byte
	File     []byte
	FileName string
	Caption  string
}

// SendText creates a text SendContent.
func SendText(text string) SendContent { return SendContent{Text: text} }

// SendImage creates an image SendContent.
func SendImage(data []byte) SendContent { return SendContent{Image: data} }

// SendVideo creates a video SendContent.
func SendVideo(data []byte) SendContent { return SendContent{Video: data} }

// SendFile creates a file SendContent.
func SendFile(data []byte, fileName string) SendContent {
	return SendContent{File: data, FileName: fileName}
}

// ReplyContent replies with any content type.
func (b *Bot) ReplyContent(ctx context.Context, msg *IncomingMessage, content SendContent) error {
	b.contextTokens.Store(msg.UserID, msg.ContextToken)
	return b.sendContent(ctx, msg.UserID, msg.ContextToken, content)
}

// SendMedia sends any content type to a user.
func (b *Bot) SendMedia(ctx context.Context, userID string, content SendContent) error {
	ct, ok := b.contextTokens.Load(userID)
	if !ok {
		return fmt.Errorf("no context_token for user %s", userID)
	}
	return b.sendContent(ctx, userID, ct.(string), content)
}

// Download downloads media from an incoming message.
// Returns nil if the message has no media. Priority: image > file > video > voice.
func (b *Bot) Download(ctx context.Context, msg *IncomingMessage) (*DownloadedMedia, error) {
	if len(msg.Images) > 0 && msg.Images[0].Media != nil {
		data, err := b.cdnDownload(ctx, msg.Images[0].Media, msg.Images[0].AESKey)
		if err != nil {
			return nil, err
		}
		return &DownloadedMedia{Data: data, Type: "image"}, nil
	}

	if len(msg.Files) > 0 && msg.Files[0].Media != nil {
		data, err := b.cdnDownload(ctx, msg.Files[0].Media, "")
		if err != nil {
			return nil, err
		}
		name := msg.Files[0].FileName
		if name == "" {
			name = "file.bin"
		}
		return &DownloadedMedia{Data: data, Type: "file", FileName: name}, nil
	}

	if len(msg.Videos) > 0 && msg.Videos[0].Media != nil {
		data, err := b.cdnDownload(ctx, msg.Videos[0].Media, "")
		if err != nil {
			return nil, err
		}
		return &DownloadedMedia{Data: data, Type: "video"}, nil
	}

	if len(msg.Voices) > 0 && msg.Voices[0].Media != nil {
		data, err := b.cdnDownload(ctx, msg.Voices[0].Media, "")
		if err != nil {
			return nil, err
		}
		return &DownloadedMedia{Data: data, Type: "voice", Format: "silk"}, nil
	}

	return nil, nil
}

// DownloadRaw downloads and decrypts a raw CDN media reference.
func (b *Bot) DownloadRaw(ctx context.Context, media *CDNMedia, aeskeyOverride string) ([]byte, error) {
	return b.cdnDownload(ctx, media, aeskeyOverride)
}

// Upload uploads data to WeChat CDN without sending a message.
func (b *Bot) Upload(ctx context.Context, data []byte, userID string, mediaType int) (*UploadResult, error) {
	creds := b.getCreds()
	if creds == nil {
		return nil, fmt.Errorf("not logged in; call Login() first")
	}
	return b.cdnUpload(ctx, creds, data, userID, mediaType)
}

// Run starts the long-poll loop. Blocks until Stop() is called or context is cancelled.
func (b *Bot) Run(ctx context.Context) error {
	creds := b.getCreds()
	if creds == nil {
		return fmt.Errorf("not logged in; call Login() first")
	}

	b.mu.Lock()
	b.stopped = false
	pollCtx, cancel := context.WithCancel(ctx)
	b.cancelPoll = cancel
	b.mu.Unlock()

	b.log("info", "Long-poll loop started")
	retryDelay := time.Second

	for {
		select {
		case <-pollCtx.Done():
			b.log("info", "Long-poll loop stopped")
			return nil
		default:
		}

		creds = b.getCreds()
		updates, err := b.client.GetUpdates(pollCtx, creds.BaseURL, creds.Token, b.cursor)
		if err != nil {
			if pollCtx.Err() != nil {
				b.log("info", "Long-poll loop stopped")
				return nil
			}

			apiErr, isAPI := err.(*protocol.APIError)
			if isAPI && apiErr.IsSessionExpired() {
				b.log("warn", "Session expired — re-login required")
				auth.ClearCredentials(b.opts.CredPath)
				b.contextTokens = sync.Map{}
				b.cursor = ""
				if _, loginErr := b.Login(pollCtx, true); loginErr != nil {
					b.reportError(loginErr)
					time.Sleep(retryDelay)
					continue
				}
				retryDelay = time.Second
				continue
			}

			b.reportError(err)
			time.Sleep(retryDelay)
			retryDelay = min(retryDelay*2, 10*time.Second)
			continue
		}

		if updates.GetUpdatesBuf != "" {
			b.cursor = updates.GetUpdatesBuf
		}
		retryDelay = time.Second

		for _, rawMsg := range updates.Msgs {
			var wire WireMessage
			if err := json.Unmarshal(rawMsg, &wire); err != nil {
				continue
			}
			b.rememberContext(&wire)
			incoming := b.parseMessage(&wire)
			if incoming == nil {
				continue
			}
			for _, h := range b.handlers {
				h(incoming)
			}
		}
	}
}

// Stop gracefully stops the poll loop.
func (b *Bot) Stop() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stopped = true
	if b.cancelPoll != nil {
		b.cancelPoll()
	}
}

// --- internal ---

func (b *Bot) sendContent(ctx context.Context, userID, contextToken string, content SendContent) error {
	// Text
	if content.Text != "" {
		return b.sendText(ctx, userID, content.Text, contextToken)
	}

	creds := b.getCreds()
	if creds == nil {
		return fmt.Errorf("not logged in; call Login() first")
	}

	// Image
	if content.Image != nil {
		result, err := b.cdnUpload(ctx, creds, content.Image, userID, int(MediaImage))
		if err != nil {
			return err
		}
		items := []map[string]interface{}{}
		if content.Caption != "" {
			items = append(items, map[string]interface{}{
				"type": 1, "text_item": map[string]string{"text": content.Caption},
			})
		}
		items = append(items, map[string]interface{}{
			"type": 2, "image_item": map[string]interface{}{
				"media":    cdnMediaMap(&result.Media),
				"mid_size": result.EncryptedFileSize,
			},
		})
		msg := protocol.BuildMediaMessage(userID, contextToken, items)
		return b.client.SendMessage(ctx, creds.BaseURL, creds.Token, msg)
	}

	// Video
	if content.Video != nil {
		result, err := b.cdnUpload(ctx, creds, content.Video, userID, int(MediaVideo))
		if err != nil {
			return err
		}
		items := []map[string]interface{}{}
		if content.Caption != "" {
			items = append(items, map[string]interface{}{
				"type": 1, "text_item": map[string]string{"text": content.Caption},
			})
		}
		items = append(items, map[string]interface{}{
			"type": 5, "video_item": map[string]interface{}{
				"media":      cdnMediaMap(&result.Media),
				"video_size": result.EncryptedFileSize,
			},
		})
		msg := protocol.BuildMediaMessage(userID, contextToken, items)
		return b.client.SendMessage(ctx, creds.BaseURL, creds.Token, msg)
	}

	// File (auto-route by extension)
	if content.File != nil {
		fileName := content.FileName
		if fileName == "" {
			fileName = "file.bin"
		}
		cat := categorizeByExtension(fileName)
		if cat == "image" {
			return b.sendContent(ctx, userID, contextToken, SendContent{Image: content.File, Caption: content.Caption})
		}
		if cat == "video" {
			return b.sendContent(ctx, userID, contextToken, SendContent{Video: content.File, Caption: content.Caption})
		}
		// Generic file
		if content.Caption != "" {
			_ = b.sendText(ctx, userID, content.Caption, contextToken)
		}
		result, err := b.cdnUpload(ctx, creds, content.File, userID, int(MediaFile))
		if err != nil {
			return err
		}
		items := []map[string]interface{}{
			{"type": 4, "file_item": map[string]interface{}{
				"media":     cdnMediaMap(&result.Media),
				"file_name": fileName,
				"len":       strconv.Itoa(len(content.File)),
			}},
		}
		msg := protocol.BuildMediaMessage(userID, contextToken, items)
		return b.client.SendMessage(ctx, creds.BaseURL, creds.Token, msg)
	}

	return fmt.Errorf("empty SendContent")
}

func (b *Bot) cdnDownload(ctx context.Context, media *CDNMedia, aeskeyOverride string) ([]byte, error) {
	downloadURL := fmt.Sprintf("%s/download?encrypted_query_param=%s",
		protocol.CDNBaseURL, url.QueryEscape(media.EncryptQueryParam))

	req, err := http.NewRequestWithContext(ctx, "GET", downloadURL, nil)
	if err != nil {
		return nil, fmt.Errorf("cdn download request: %w", err)
	}
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cdn download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("cdn download failed: HTTP %d", resp.StatusCode)
	}

	ciphertext, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("cdn download read: %w", err)
	}

	keySource := aeskeyOverride
	if keySource == "" {
		keySource = media.AESKey
	}
	if keySource == "" {
		return nil, fmt.Errorf("no AES key available for decryption")
	}

	aesKey, err := crypto.DecodeAESKey(keySource)
	if err != nil {
		return nil, fmt.Errorf("decode aes key: %w", err)
	}

	return crypto.DecryptAESECB(ciphertext, aesKey)
}

func (b *Bot) cdnUpload(ctx context.Context, creds *auth.Credentials, data []byte, userID string, mediaType int) (*UploadResult, error) {
	aesKey, err := crypto.GenerateAESKey()
	if err != nil {
		return nil, fmt.Errorf("generate aes key: %w", err)
	}
	ciphertext, err := crypto.EncryptAESECB(data, aesKey)
	if err != nil {
		return nil, fmt.Errorf("encrypt: %w", err)
	}

	var fileKeyBuf [16]byte
	if _, err := rand.Read(fileKeyBuf[:]); err != nil {
		return nil, fmt.Errorf("generate file key: %w", err)
	}
	fileKey := hex.EncodeToString(fileKeyBuf[:])

	rawMD5 := md5.Sum(data)
	rawMD5Hex := hex.EncodeToString(rawMD5[:])

	uploadResp, err := b.client.GetUploadURL(ctx, creds.BaseURL, creds.Token, protocol.GetUploadURLRequest{
		FileKey:     fileKey,
		MediaType:   mediaType,
		ToUserID:    userID,
		RawSize:     len(data),
		RawFileMD5:  rawMD5Hex,
		FileSize:    len(ciphertext),
		NoNeedThumb: true,
		AESKey:      crypto.EncodeAESKeyHex(aesKey),
	})
	if err != nil {
		return nil, fmt.Errorf("getuploadurl: %w", err)
	}
	if uploadResp.UploadParam == "" {
		return nil, fmt.Errorf("getuploadurl did not return upload_param")
	}

	uploadURL := fmt.Sprintf("%s/upload?encrypted_query_param=%s&filekey=%s",
		protocol.CDNBaseURL,
		url.QueryEscape(uploadResp.UploadParam),
		url.QueryEscape(fileKey))

	req, err := http.NewRequestWithContext(ctx, "POST", uploadURL, bytes.NewReader(ciphertext))
	if err != nil {
		return nil, fmt.Errorf("cdn upload request: %w", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cdn upload: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		errMsg := resp.Header.Get("x-error-message")
		if errMsg == "" {
			errMsg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("cdn upload failed: %s", errMsg)
	}

	encryptQueryParam := resp.Header.Get("x-encrypted-param")
	if encryptQueryParam == "" {
		return nil, fmt.Errorf("cdn upload succeeded but x-encrypted-param header missing")
	}

	return &UploadResult{
		Media: CDNMedia{
			EncryptQueryParam: encryptQueryParam,
			AESKey:            crypto.EncodeAESKeyBase64(aesKey),
			EncryptType:       1,
		},
		AESKey:            aesKey,
		EncryptedFileSize: len(ciphertext),
	}, nil
}

func cdnMediaMap(m *CDNMedia) map[string]interface{} {
	return map[string]interface{}{
		"encrypt_query_param": m.EncryptQueryParam,
		"aes_key":             m.AESKey,
		"encrypt_type":        m.EncryptType,
	}
}

var imageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true, ".svg": true}
var videoExts = map[string]bool{".mp4": true, ".mov": true, ".webm": true, ".mkv": true, ".avi": true}

func categorizeByExtension(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	if imageExts[ext] {
		return "image"
	}
	if videoExts[ext] {
		return "video"
	}
	return "file"
}

func (b *Bot) sendText(ctx context.Context, userID, text, contextToken string) error {
	creds := b.getCreds()
	chunks := chunkText(text, 4000)
	for _, chunk := range chunks {
		msg := protocol.BuildTextMessage(userID, contextToken, chunk)
		if err := b.client.SendMessage(ctx, creds.BaseURL, creds.Token, msg); err != nil {
			return err
		}
	}
	return nil
}

func (b *Bot) rememberContext(wire *WireMessage) {
	userID := wire.FromUserID
	if wire.MessageType == MessageTypeBot {
		userID = wire.ToUserID
	}
	if userID != "" && wire.ContextToken != "" {
		b.contextTokens.Store(userID, wire.ContextToken)
	}
}

func (b *Bot) parseMessage(wire *WireMessage) *IncomingMessage {
	if wire.MessageType != MessageTypeUser {
		return nil
	}

	msg := &IncomingMessage{
		UserID:       wire.FromUserID,
		Text:         extractText(wire.ItemList),
		Type:         detectType(wire.ItemList),
		Timestamp:    time.UnixMilli(wire.CreateTimeMs),
		Raw:          wire,
		ContextToken: wire.ContextToken,
	}

	for _, item := range wire.ItemList {
		if item.ImageItem != nil {
			msg.Images = append(msg.Images, ImageContent{
				Media: item.ImageItem.Media, ThumbMedia: item.ImageItem.ThumbMedia,
				AESKey: item.ImageItem.AESKey, URL: item.ImageItem.URL,
				Width: item.ImageItem.ThumbWidth, Height: item.ImageItem.ThumbHeight,
			})
		}
		if item.VoiceItem != nil {
			msg.Voices = append(msg.Voices, VoiceContent{
				Media: item.VoiceItem.Media, Text: item.VoiceItem.Text,
				DurationMs: item.VoiceItem.Playtime, EncodeType: item.VoiceItem.EncodeType,
			})
		}
		if item.FileItem != nil {
			size, _ := strconv.ParseInt(item.FileItem.Len, 10, 64)
			msg.Files = append(msg.Files, FileContent{
				Media: item.FileItem.Media, FileName: item.FileItem.FileName,
				MD5: item.FileItem.MD5, Size: size,
			})
		}
		if item.VideoItem != nil {
			msg.Videos = append(msg.Videos, VideoContent{
				Media: item.VideoItem.Media, ThumbMedia: item.VideoItem.ThumbMedia,
				DurationMs: item.VideoItem.PlayLength,
			})
		}
		if item.RefMsg != nil {
			q := &QuotedMessage{Title: item.RefMsg.Title}
			if item.RefMsg.MessageItem != nil && item.RefMsg.MessageItem.TextItem != nil {
				q.Text = item.RefMsg.MessageItem.TextItem.Text
			}
			msg.QuotedMessage = q
		}
	}

	return msg
}

func (b *Bot) getCreds() *auth.Credentials {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.creds
}

func (b *Bot) reportError(err error) {
	b.log("error", "%v", err)
	if b.opts.OnError != nil {
		b.opts.OnError(err)
	}
}

func (b *Bot) log(level, format string, args ...interface{}) {
	if b.opts.LogLevel == "silent" {
		return
	}
	fmt.Fprintf(os.Stderr, "[wechatbot] %s\n", fmt.Sprintf(format, args...))
}

func detectType(items []MessageItem) ContentType {
	if len(items) == 0 {
		return ContentText
	}
	switch items[0].Type {
	case ItemImage:
		return ContentImage
	case ItemVoice:
		return ContentVoice
	case ItemFile:
		return ContentFile
	case ItemVideo:
		return ContentVideo
	default:
		return ContentText
	}
}

func extractText(items []MessageItem) string {
	var parts []string
	for _, item := range items {
		switch item.Type {
		case ItemText:
			if item.TextItem != nil {
				parts = append(parts, item.TextItem.Text)
			}
		case ItemImage:
			if item.ImageItem != nil && item.ImageItem.URL != "" {
				parts = append(parts, item.ImageItem.URL)
			} else {
				parts = append(parts, "[image]")
			}
		case ItemVoice:
			if item.VoiceItem != nil && item.VoiceItem.Text != "" {
				parts = append(parts, item.VoiceItem.Text)
			} else {
				parts = append(parts, "[voice]")
			}
		case ItemFile:
			if item.FileItem != nil && item.FileItem.FileName != "" {
				parts = append(parts, item.FileItem.FileName)
			} else {
				parts = append(parts, "[file]")
			}
		case ItemVideo:
			parts = append(parts, "[video]")
		}
	}
	return strings.Join(parts, "\n")
}

func chunkText(text string, limit int) []string {
	if len(text) <= limit {
		return []string{text}
	}
	var chunks []string
	for len(text) > 0 {
		if len(text) <= limit {
			chunks = append(chunks, text)
			break
		}
		cut := limit
		if idx := strings.LastIndex(text[:limit], "\n\n"); idx > limit*3/10 {
			cut = idx + 2
		} else if idx := strings.LastIndex(text[:limit], "\n"); idx > limit*3/10 {
			cut = idx + 1
		} else if idx := strings.LastIndex(text[:limit], " "); idx > limit*3/10 {
			cut = idx + 1
		}
		chunks = append(chunks, text[:cut])
		text = text[cut:]
	}
	if len(chunks) == 0 {
		return []string{""}
	}
	return chunks
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
