package wechatbot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/corespeed-io/wechatbot/golang/internal/auth"
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

func (b *Bot) sendText(ctx context.Context, userID, text, contextToken string) error {
	creds := b.getCreds()
	chunks := chunkText(text, 2000)
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
