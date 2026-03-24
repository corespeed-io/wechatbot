// Package wechatbot provides a WeChat iLink Bot SDK for Go.
//
// It handles QR login, long-poll message receiving, text/media sending,
// typing indicators, context_token management, and AES-128-ECB CDN crypto.
package wechatbot

import "time"

// MessageType indicates who sent the message.
type MessageType int

const (
	MessageTypeUser MessageType = 1
	MessageTypeBot  MessageType = 2
)

// MessageState indicates the message delivery state.
type MessageState int

const (
	MessageStateNew        MessageState = 0
	MessageStateGenerating MessageState = 1
	MessageStateFinish     MessageState = 2
)

// MessageItemType indicates the content type of a message item.
type MessageItemType int

const (
	ItemText  MessageItemType = 1
	ItemImage MessageItemType = 2
	ItemVoice MessageItemType = 3
	ItemFile  MessageItemType = 4
	ItemVideo MessageItemType = 5
)

// MediaType is used in upload requests.
type MediaType int

const (
	MediaImage MediaType = 1
	MediaVideo MediaType = 2
	MediaFile  MediaType = 3
	MediaVoice MediaType = 4
)

// BaseInfo is included in every POST request body.
type BaseInfo struct {
	ChannelVersion string `json:"channel_version"`
}

// CDNMedia references an encrypted file on the WeChat CDN.
type CDNMedia struct {
	EncryptQueryParam string `json:"encrypt_query_param"`
	AESKey            string `json:"aes_key"`
	EncryptType       int    `json:"encrypt_type,omitempty"`
}

// TextItem holds text content.
type TextItem struct {
	Text string `json:"text"`
}

// ImageItem holds image content and CDN references.
type ImageItem struct {
	Media       *CDNMedia `json:"media,omitempty"`
	ThumbMedia  *CDNMedia `json:"thumb_media,omitempty"`
	AESKey      string    `json:"aeskey,omitempty"`
	URL         string    `json:"url,omitempty"`
	MidSize     int64     `json:"mid_size,omitempty"`
	ThumbSize   int64     `json:"thumb_size,omitempty"`
	ThumbWidth  int       `json:"thumb_width,omitempty"`
	ThumbHeight int       `json:"thumb_height,omitempty"`
	HDSize      int64     `json:"hd_size,omitempty"`
}

// VoiceItem holds voice content.
type VoiceItem struct {
	Media      *CDNMedia `json:"media,omitempty"`
	EncodeType int       `json:"encode_type,omitempty"`
	Text       string    `json:"text,omitempty"`
	Playtime   int       `json:"playtime,omitempty"`
}

// FileItem holds file content.
type FileItem struct {
	Media    *CDNMedia `json:"media,omitempty"`
	FileName string    `json:"file_name,omitempty"`
	MD5      string    `json:"md5,omitempty"`
	Len      string    `json:"len,omitempty"`
}

// VideoItem holds video content.
type VideoItem struct {
	Media      *CDNMedia `json:"media,omitempty"`
	VideoSize  int64     `json:"video_size,omitempty"`
	PlayLength int       `json:"play_length,omitempty"`
	ThumbMedia *CDNMedia `json:"thumb_media,omitempty"`
}

// RefMessage represents a quoted/referenced message.
type RefMessage struct {
	Title       string       `json:"title,omitempty"`
	MessageItem *MessageItem `json:"message_item,omitempty"`
}

// MessageItem is a single content item within a message.
type MessageItem struct {
	Type      MessageItemType `json:"type"`
	TextItem  *TextItem       `json:"text_item,omitempty"`
	ImageItem *ImageItem      `json:"image_item,omitempty"`
	VoiceItem *VoiceItem      `json:"voice_item,omitempty"`
	FileItem  *FileItem       `json:"file_item,omitempty"`
	VideoItem *VideoItem      `json:"video_item,omitempty"`
	RefMsg    *RefMessage     `json:"ref_msg,omitempty"`
}

// WireMessage is the raw message from the iLink API.
type WireMessage struct {
	Seq          int64           `json:"seq,omitempty"`
	MessageID    int64           `json:"message_id,omitempty"`
	FromUserID   string          `json:"from_user_id"`
	ToUserID     string          `json:"to_user_id"`
	ClientID     string          `json:"client_id"`
	CreateTimeMs int64           `json:"create_time_ms"`
	MessageType  MessageType     `json:"message_type"`
	MessageState MessageState    `json:"message_state"`
	ContextToken string          `json:"context_token"`
	ItemList     []MessageItem   `json:"item_list"`
}

// ContentType is the primary type of an incoming message.
type ContentType string

const (
	ContentText  ContentType = "text"
	ContentImage ContentType = "image"
	ContentVoice ContentType = "voice"
	ContentFile  ContentType = "file"
	ContentVideo ContentType = "video"
)

// IncomingMessage is a parsed, user-friendly representation.
type IncomingMessage struct {
	UserID        string
	Text          string
	Type          ContentType
	Timestamp     time.Time
	Images        []ImageContent
	Voices        []VoiceContent
	Files         []FileContent
	Videos        []VideoContent
	QuotedMessage *QuotedMessage
	Raw           *WireMessage
	ContextToken  string // internal, managed by SDK
}

// ImageContent holds parsed image data from a message.
type ImageContent struct {
	Media      *CDNMedia
	ThumbMedia *CDNMedia
	AESKey     string
	URL        string
	Width      int
	Height     int
}

// VoiceContent holds parsed voice data.
type VoiceContent struct {
	Media      *CDNMedia
	Text       string
	DurationMs int
	EncodeType int
}

// FileContent holds parsed file data.
type FileContent struct {
	Media    *CDNMedia
	FileName string
	MD5      string
	Size     int64
}

// VideoContent holds parsed video data.
type VideoContent struct {
	Media      *CDNMedia
	ThumbMedia *CDNMedia
	DurationMs int
	Width      int
	Height     int
}

// QuotedMessage represents a referenced message.
type QuotedMessage struct {
	Title string
	Text  string
	Type  ContentType
}

// DownloadedMedia is the result of downloading media from a message.
type DownloadedMedia struct {
	Data     []byte
	Type     string // "image", "file", "video", "voice"
	FileName string
	Format   string // "silk" for voice
}

// UploadResult is the result of uploading media to CDN.
type UploadResult struct {
	Media             CDNMedia
	AESKey            []byte
	EncryptedFileSize int
}

// Credentials holds login credentials.
type Credentials struct {
	Token     string `json:"token"`
	BaseURL   string `json:"baseUrl"`
	AccountID string `json:"accountId"`
	UserID    string `json:"userId"`
	SavedAt   string `json:"savedAt,omitempty"`
}
