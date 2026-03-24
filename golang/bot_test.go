package wechatbot

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestChunkTextShort(t *testing.T) {
	chunks := chunkText("hello", 100)
	if len(chunks) != 1 || chunks[0] != "hello" {
		t.Fatalf("expected single chunk, got %v", chunks)
	}
}

func TestChunkTextEmpty(t *testing.T) {
	chunks := chunkText("", 100)
	if len(chunks) != 1 || chunks[0] != "" {
		t.Fatalf("expected single empty chunk, got %v", chunks)
	}
}

func TestChunkTextSplitsOnParagraph(t *testing.T) {
	text := "aaaa\n\nbbbb"
	chunks := chunkText(text, 7)
	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d: %v", len(chunks), chunks)
	}
	if chunks[0] != "aaaa\n\n" || chunks[1] != "bbbb" {
		t.Fatalf("unexpected chunks: %v", chunks)
	}
}

func TestChunkTextSplitsOnNewline(t *testing.T) {
	text := "aaaa\nbbbb"
	chunks := chunkText(text, 7)
	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d: %v", len(chunks), chunks)
	}
	if chunks[0] != "aaaa\n" || chunks[1] != "bbbb" {
		t.Fatalf("unexpected chunks: %v", chunks)
	}
}

func TestDetectTypeText(t *testing.T) {
	items := []MessageItem{{Type: ItemText, TextItem: &TextItem{Text: "hi"}}}
	if detectType(items) != ContentText {
		t.Fatal("expected text")
	}
}

func TestDetectTypeImage(t *testing.T) {
	items := []MessageItem{{Type: ItemImage, ImageItem: &ImageItem{URL: "http://img"}}}
	if detectType(items) != ContentImage {
		t.Fatal("expected image")
	}
}

func TestDetectTypeVoice(t *testing.T) {
	items := []MessageItem{{Type: ItemVoice, VoiceItem: &VoiceItem{Text: "hello"}}}
	if detectType(items) != ContentVoice {
		t.Fatal("expected voice")
	}
}

func TestDetectTypeFile(t *testing.T) {
	items := []MessageItem{{Type: ItemFile, FileItem: &FileItem{FileName: "doc.pdf"}}}
	if detectType(items) != ContentFile {
		t.Fatal("expected file")
	}
}

func TestDetectTypeVideo(t *testing.T) {
	items := []MessageItem{{Type: ItemVideo, VideoItem: &VideoItem{}}}
	if detectType(items) != ContentVideo {
		t.Fatal("expected video")
	}
}

func TestDetectTypeEmpty(t *testing.T) {
	if detectType(nil) != ContentText {
		t.Fatal("expected text for empty items")
	}
}

func TestExtractTextSingle(t *testing.T) {
	items := []MessageItem{{Type: ItemText, TextItem: &TextItem{Text: "hello world"}}}
	if extractText(items) != "hello world" {
		t.Fatal("unexpected text")
	}
}

func TestExtractTextMulti(t *testing.T) {
	items := []MessageItem{
		{Type: ItemText, TextItem: &TextItem{Text: "line1"}},
		{Type: ItemText, TextItem: &TextItem{Text: "line2"}},
	}
	if extractText(items) != "line1\nline2" {
		t.Fatalf("unexpected text: %q", extractText(items))
	}
}

func TestExtractTextImageURL(t *testing.T) {
	items := []MessageItem{{Type: ItemImage, ImageItem: &ImageItem{URL: "http://img.jpg"}}}
	if extractText(items) != "http://img.jpg" {
		t.Fatalf("unexpected text: %q", extractText(items))
	}
}

func TestExtractTextImagePlaceholder(t *testing.T) {
	items := []MessageItem{{Type: ItemImage, ImageItem: &ImageItem{}}}
	if extractText(items) != "[image]" {
		t.Fatalf("unexpected text: %q", extractText(items))
	}
}

func TestExtractTextVoiceWithText(t *testing.T) {
	items := []MessageItem{{Type: ItemVoice, VoiceItem: &VoiceItem{Text: "hello"}}}
	if extractText(items) != "hello" {
		t.Fatalf("unexpected text: %q", extractText(items))
	}
}

func TestExtractTextVoicePlaceholder(t *testing.T) {
	items := []MessageItem{{Type: ItemVoice, VoiceItem: &VoiceItem{}}}
	if extractText(items) != "[voice]" {
		t.Fatalf("unexpected text: %q", extractText(items))
	}
}

func TestExtractTextFile(t *testing.T) {
	items := []MessageItem{{Type: ItemFile, FileItem: &FileItem{FileName: "report.pdf"}}}
	if extractText(items) != "report.pdf" {
		t.Fatalf("unexpected text: %q", extractText(items))
	}
}

func TestExtractTextVideo(t *testing.T) {
	items := []MessageItem{{Type: ItemVideo, VideoItem: &VideoItem{}}}
	if extractText(items) != "[video]" {
		t.Fatalf("unexpected text: %q", extractText(items))
	}
}

func TestParseMessageUserText(t *testing.T) {
	b := New()
	wire := &WireMessage{
		FromUserID:   "user123",
		ToUserID:     "bot456",
		ClientID:     "c1",
		CreateTimeMs: 1700000000000,
		MessageType:  MessageTypeUser,
		MessageState: MessageStateFinish,
		ContextToken: "ctx-abc",
		ItemList: []MessageItem{
			{Type: ItemText, TextItem: &TextItem{Text: "hello"}},
		},
	}
	msg := b.parseMessage(wire)
	if msg == nil {
		t.Fatal("expected non-nil message")
	}
	if msg.UserID != "user123" {
		t.Fatalf("unexpected user ID: %s", msg.UserID)
	}
	if msg.Text != "hello" {
		t.Fatalf("unexpected text: %s", msg.Text)
	}
	if msg.Type != ContentText {
		t.Fatalf("unexpected type: %s", msg.Type)
	}
	if msg.ContextToken != "ctx-abc" {
		t.Fatalf("unexpected context token: %s", msg.ContextToken)
	}
	expectedTime := time.UnixMilli(1700000000000)
	if !msg.Timestamp.Equal(expectedTime) {
		t.Fatalf("unexpected timestamp: %v", msg.Timestamp)
	}
}

func TestParseMessageSkipsBot(t *testing.T) {
	b := New()
	wire := &WireMessage{
		FromUserID:   "bot456",
		ToUserID:     "user123",
		MessageType:  MessageTypeBot,
		MessageState: MessageStateFinish,
		ContextToken: "ctx-abc",
		ItemList:     []MessageItem{{Type: ItemText, TextItem: &TextItem{Text: "reply"}}},
	}
	msg := b.parseMessage(wire)
	if msg != nil {
		t.Fatal("expected nil for bot message")
	}
}

func TestParseMessageWithImage(t *testing.T) {
	b := New()
	wire := &WireMessage{
		FromUserID:   "user123",
		ToUserID:     "bot456",
		MessageType:  MessageTypeUser,
		MessageState: MessageStateFinish,
		ContextToken: "ctx-abc",
		ItemList: []MessageItem{
			{Type: ItemImage, ImageItem: &ImageItem{
				URL:         "http://img.jpg",
				ThumbWidth:  100,
				ThumbHeight: 200,
			}},
		},
	}
	msg := b.parseMessage(wire)
	if msg == nil {
		t.Fatal("expected non-nil message")
	}
	if len(msg.Images) != 1 {
		t.Fatalf("expected 1 image, got %d", len(msg.Images))
	}
	if msg.Images[0].URL != "http://img.jpg" {
		t.Fatalf("unexpected URL: %s", msg.Images[0].URL)
	}
	if msg.Images[0].Width != 100 || msg.Images[0].Height != 200 {
		t.Fatalf("unexpected dimensions: %dx%d", msg.Images[0].Width, msg.Images[0].Height)
	}
}

func TestParseMessageWithQuoted(t *testing.T) {
	b := New()
	wire := &WireMessage{
		FromUserID:   "user123",
		ToUserID:     "bot456",
		MessageType:  MessageTypeUser,
		MessageState: MessageStateFinish,
		ContextToken: "ctx-abc",
		ItemList: []MessageItem{
			{Type: ItemText, TextItem: &TextItem{Text: "replying"},
				RefMsg: &RefMessage{
					Title:       "Original",
					MessageItem: &MessageItem{Type: ItemText, TextItem: &TextItem{Text: "original text"}},
				}},
		},
	}
	msg := b.parseMessage(wire)
	if msg == nil {
		t.Fatal("expected non-nil message")
	}
	if msg.QuotedMessage == nil {
		t.Fatal("expected quoted message")
	}
	if msg.QuotedMessage.Title != "Original" {
		t.Fatalf("unexpected title: %s", msg.QuotedMessage.Title)
	}
	if msg.QuotedMessage.Text != "original text" {
		t.Fatalf("unexpected quoted text: %s", msg.QuotedMessage.Text)
	}
}

func TestRememberContextUser(t *testing.T) {
	b := New()
	wire := &WireMessage{
		FromUserID:   "user123",
		ToUserID:     "bot456",
		MessageType:  MessageTypeUser,
		ContextToken: "ctx-new",
	}
	b.rememberContext(wire)
	ct, ok := b.contextTokens.Load("user123")
	if !ok || ct.(string) != "ctx-new" {
		t.Fatalf("expected context token ctx-new, got %v", ct)
	}
}

func TestRememberContextBot(t *testing.T) {
	b := New()
	wire := &WireMessage{
		FromUserID:   "bot456",
		ToUserID:     "user123",
		MessageType:  MessageTypeBot,
		ContextToken: "ctx-bot",
	}
	b.rememberContext(wire)
	ct, ok := b.contextTokens.Load("user123")
	if !ok || ct.(string) != "ctx-bot" {
		t.Fatalf("expected context token ctx-bot for toUserID, got %v", ct)
	}
}

func TestWireMessageJSON(t *testing.T) {
	wire := WireMessage{
		FromUserID:   "user1",
		ToUserID:     "bot1",
		ClientID:     "c1",
		CreateTimeMs: 1700000000000,
		MessageType:  MessageTypeUser,
		MessageState: MessageStateFinish,
		ContextToken: "ctx",
		ItemList: []MessageItem{
			{Type: ItemText, TextItem: &TextItem{Text: "hello"}},
		},
	}
	data, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	var decoded WireMessage
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.FromUserID != wire.FromUserID || decoded.MessageType != wire.MessageType {
		t.Fatalf("round-trip mismatch: %+v", decoded)
	}
	if len(decoded.ItemList) != 1 || decoded.ItemList[0].TextItem.Text != "hello" {
		t.Fatal("item list mismatch")
	}
}

func TestTypesEnumValues(t *testing.T) {
	if MessageTypeUser != 1 || MessageTypeBot != 2 {
		t.Fatal("MessageType enum mismatch")
	}
	if MessageStateNew != 0 || MessageStateGenerating != 1 || MessageStateFinish != 2 {
		t.Fatal("MessageState enum mismatch")
	}
	if ItemText != 1 || ItemImage != 2 || ItemVoice != 3 || ItemFile != 4 || ItemVideo != 5 {
		t.Fatal("MessageItemType enum mismatch")
	}
}

func TestCategorizeByExtension(t *testing.T) {
	tests := []struct{ name, want string }{
		{"photo.png", "image"},
		{"photo.JPG", "image"},
		{"anim.gif", "image"},
		{"clip.mp4", "video"},
		{"clip.MOV", "video"},
		{"report.pdf", "file"},
		{"data.csv", "file"},
		{"noext", "file"},
	}
	for _, tc := range tests {
		got := categorizeByExtension(tc.name)
		if got != tc.want {
			t.Errorf("categorizeByExtension(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestCdnMediaMap(t *testing.T) {
	m := &CDNMedia{EncryptQueryParam: "param=1", AESKey: "key123", EncryptType: 1}
	d := cdnMediaMap(m)
	if d["encrypt_query_param"] != "param=1" || d["aes_key"] != "key123" || d["encrypt_type"] != 1 {
		t.Fatalf("unexpected cdnMediaMap result: %v", d)
	}
}

func TestSendContentConstructors(t *testing.T) {
	s := SendText("hello")
	if s.Text != "hello" {
		t.Fatalf("SendText: got %q", s.Text)
	}
	s = SendImage([]byte{1, 2, 3})
	if len(s.Image) != 3 {
		t.Fatalf("SendImage: got len %d", len(s.Image))
	}
	s = SendVideo([]byte{4, 5})
	if len(s.Video) != 2 {
		t.Fatalf("SendVideo: got len %d", len(s.Video))
	}
	s = SendFile([]byte{6}, "test.pdf")
	if len(s.File) != 1 || s.FileName != "test.pdf" {
		t.Fatalf("SendFile: got len=%d name=%q", len(s.File), s.FileName)
	}
}

func TestCredentialsJSON(t *testing.T) {
	creds := Credentials{
		Token:     "tok",
		BaseURL:   "https://api.example.com",
		AccountID: "acc1",
		UserID:    "uid1",
		SavedAt:   "2024-01-01T00:00:00Z",
	}
	data, err := json.Marshal(creds)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Credentials
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(creds, decoded) {
		t.Fatalf("round-trip mismatch: %+v vs %+v", creds, decoded)
	}
	// Verify JSON field names
	var m map[string]interface{}
	json.Unmarshal(data, &m)
	if _, ok := m["baseUrl"]; !ok {
		t.Fatal("expected camelCase 'baseUrl' in JSON")
	}
	if _, ok := m["accountId"]; !ok {
		t.Fatal("expected camelCase 'accountId' in JSON")
	}
}
