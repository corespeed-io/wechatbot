//! Main WeChatBot client.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tokio::time::{sleep, Duration};
use tracing::{error, info, warn};

use crate::cdn::CdnClient;
use crate::crypto;
use crate::error::{Result, WeChatBotError};
use crate::protocol::{self, ILinkClient};
use crate::types::*;
use md5::{Digest, Md5};
use rand::Rng;
use serde_json::json;

/// Message handler callback type.
pub type MessageHandler = Box<dyn Fn(&IncomingMessage) + Send + Sync>;

/// Bot configuration options.
pub struct BotOptions {
    pub base_url: Option<String>,
    pub cred_path: Option<String>,
    pub on_qr_url: Option<Box<dyn Fn(&str) + Send + Sync>>,
    pub on_error: Option<Box<dyn Fn(&WeChatBotError) + Send + Sync>>,
}

impl Default for BotOptions {
    fn default() -> Self {
        Self {
            base_url: None,
            cred_path: None,
            on_qr_url: None,
            on_error: None,
        }
    }
}

/// WeChatBot is the main entry point.
pub struct WeChatBot {
    client: Arc<ILinkClient>,
    cdn: CdnClient,
    credentials: RwLock<Option<Credentials>>,
    context_tokens: RwLock<HashMap<String, String>>,
    handlers: Mutex<Vec<MessageHandler>>,
    cursor: RwLock<String>,
    base_url: RwLock<String>,
    cred_path: Option<String>,
    stopped: RwLock<bool>,
    on_qr_url: Option<Box<dyn Fn(&str) + Send + Sync>>,
    on_error: Option<Box<dyn Fn(&WeChatBotError) + Send + Sync>>,
}

impl WeChatBot {
    /// Create a new bot instance.
    pub fn new(opts: BotOptions) -> Self {
        Self {
            client: Arc::new(ILinkClient::new()),
            cdn: CdnClient::new(),
            credentials: RwLock::new(None),
            context_tokens: RwLock::new(HashMap::new()),
            handlers: Mutex::new(Vec::new()),
            cursor: RwLock::new(String::new()),
            base_url: RwLock::new(
                opts.base_url
                    .unwrap_or_else(|| protocol::DEFAULT_BASE_URL.to_string()),
            ),
            cred_path: opts.cred_path,
            stopped: RwLock::new(false),
            on_qr_url: opts.on_qr_url,
            on_error: opts.on_error,
        }
    }

    /// Maximum number of QR code refresh attempts before giving up.
    const MAX_QR_REFRESH: u32 = 3;
    /// Fixed API base URL for QR code requests.
    const FIXED_QR_BASE_URL: &'static str = "https://ilinkai.weixin.qq.com";

    /// Login via QR code. Returns credentials on success.
    pub async fn login(&self, force: bool) -> Result<Credentials> {
        let base_url = self.base_url.read().await.clone();

        if !force {
            if let Some(creds) = self.load_credentials().await? {
                *self.credentials.write().await = Some(creds.clone());
                *self.base_url.write().await = creds.base_url.clone();
                info!("Loaded stored credentials for {}", creds.user_id);
                return Ok(creds);
            }
        }

        // QR code login flow
        let mut qr_refresh_count = 0u32;
        loop {
            qr_refresh_count += 1;
            if qr_refresh_count > Self::MAX_QR_REFRESH {
                return Err(WeChatBotError::Auth(format!(
                    "QR code expired {} times — login aborted",
                    Self::MAX_QR_REFRESH
                )));
            }

            let qr = self.client.get_qr_code(Self::FIXED_QR_BASE_URL).await?;

            if let Some(ref cb) = self.on_qr_url {
                cb(&qr.qrcode_img_content);
            } else {
                eprintln!("[wechatbot] Scan: {}", qr.qrcode_img_content);
            }

            let mut last_status = String::new();
            let mut current_poll_base_url = Self::FIXED_QR_BASE_URL.to_string();
            loop {
                let status = self
                    .client
                    .poll_qr_status(&current_poll_base_url, &qr.qrcode)
                    .await?;

                if status.status != last_status {
                    last_status = status.status.clone();
                    match status.status.as_str() {
                        "scaned" => info!("QR scanned — confirm in WeChat"),
                        "expired" => warn!("QR expired — requesting new one"),
                        "confirmed" => info!("Login confirmed"),
                        _ => {}
                    }
                }

                if status.status == "confirmed" {
                    let token = status
                        .bot_token
                        .ok_or_else(|| WeChatBotError::Auth("missing bot_token".into()))?;
                    let creds = Credentials {
                        token,
                        base_url: status.baseurl.unwrap_or_else(|| base_url.clone()),
                        account_id: status.ilink_bot_id.unwrap_or_default(),
                        user_id: status.ilink_user_id.unwrap_or_default(),
                        saved_at: Some(chrono_now()),
                    };
                    self.save_credentials(&creds).await?;
                    *self.credentials.write().await = Some(creds.clone());
                    *self.base_url.write().await = creds.base_url.clone();
                    return Ok(creds);
                }

                // Handle IDC redirect
                if status.status == "scaned_but_redirect" {
                    if let Some(ref host) = status.redirect_host {
                        current_poll_base_url = format!("https://{}", host);
                        info!("IDC redirect, switching polling host to {}", host);
                    } else {
                        warn!("Received scaned_but_redirect but redirect_host is missing");
                    }
                    sleep(Duration::from_secs(2)).await;
                    continue;
                }

                if status.status == "expired" {
                    break;
                }

                sleep(Duration::from_secs(2)).await;
            }
        }
    }

    /// Register a message handler.
    pub async fn on_message(&self, handler: MessageHandler) {
        self.handlers.lock().await.push(handler);
    }

    /// Reply to an incoming message.
    pub async fn reply(&self, msg: &IncomingMessage, text: &str) -> Result<()> {
        self.context_tokens
            .write()
            .await
            .insert(msg.user_id.clone(), msg.context_token.clone());
        self.send_text(&msg.user_id, text, &msg.context_token).await
    }

    /// Send text to a user (needs prior context_token).
    pub async fn send(&self, user_id: &str, text: &str) -> Result<()> {
        let ct = self.context_tokens.read().await.get(user_id).cloned();
        let ct = ct.ok_or_else(|| WeChatBotError::NoContext(user_id.to_string()))?;
        self.send_text(user_id, text, &ct).await
    }

    /// Show "typing..." indicator.
    pub async fn send_typing(&self, user_id: &str) -> Result<()> {
        let ct = self.context_tokens.read().await.get(user_id).cloned();
        let ct = ct.ok_or_else(|| WeChatBotError::NoContext(user_id.to_string()))?;
        let (base_url, token) = self.get_auth().await?;
        let config = self
            .client
            .get_config(&base_url, &token, user_id, &ct)
            .await?;
        if let Some(ticket) = config.typing_ticket {
            self.client
                .send_typing(&base_url, &token, user_id, &ticket, 1)
                .await?;
        }
        Ok(())
    }

    /// Reply with media content (image, video, or file).
    pub async fn reply_media(&self, msg: &IncomingMessage, content: SendContent) -> Result<()> {
        self.context_tokens
            .write()
            .await
            .insert(msg.user_id.clone(), msg.context_token.clone());
        self.send_content(&msg.user_id, &msg.context_token, content)
            .await
    }

    /// Send any content type to a user (needs prior context_token).
    pub async fn send_media(&self, user_id: &str, content: SendContent) -> Result<()> {
        let ct = self.context_tokens.read().await.get(user_id).cloned();
        let ct = ct.ok_or_else(|| WeChatBotError::NoContext(user_id.to_string()))?;
        self.send_content(user_id, &ct, content).await
    }

    /// Download media from an incoming message.
    /// Returns None if the message has no media. Priority: image > file > video > voice.
    pub async fn download(&self, msg: &IncomingMessage) -> Result<Option<DownloadedMedia>> {
        if let Some(img) = msg.images.first() {
            if let Some(ref media) = img.media {
                let data = self.cdn.download(media, img.aes_key.as_deref()).await?;
                return Ok(Some(DownloadedMedia {
                    data,
                    media_type: "image".into(),
                    file_name: None,
                    format: None,
                }));
            }
        }
        if let Some(file) = msg.files.first() {
            if let Some(ref media) = file.media {
                let data = self.cdn.download(media, None).await?;
                return Ok(Some(DownloadedMedia {
                    data,
                    media_type: "file".into(),
                    file_name: Some(file.file_name.clone().unwrap_or_else(|| "file.bin".into())),
                    format: None,
                }));
            }
        }
        if let Some(video) = msg.videos.first() {
            if let Some(ref media) = video.media {
                let data = self.cdn.download(media, None).await?;
                return Ok(Some(DownloadedMedia {
                    data,
                    media_type: "video".into(),
                    file_name: None,
                    format: None,
                }));
            }
        }
        if let Some(voice) = msg.voices.first() {
            if let Some(ref media) = voice.media {
                let data = self.cdn.download(media, None).await?;
                return Ok(Some(DownloadedMedia {
                    data,
                    media_type: "voice".into(),
                    file_name: None,
                    format: Some("silk".into()),
                }));
            }
        }
        Ok(None)
    }

    /// Download and decrypt a raw CDN media reference.
    pub async fn download_raw(
        &self,
        media: &CDNMedia,
        aeskey_override: Option<&str>,
    ) -> Result<Vec<u8>> {
        self.cdn.download(media, aeskey_override).await
    }

    /// Upload data to WeChat CDN without sending a message.
    pub async fn upload(
        &self,
        data: &[u8],
        user_id: &str,
        media_type: i32,
    ) -> Result<UploadResult> {
        let (base_url, token) = self.get_auth().await?;
        self.cdn_upload(&base_url, &token, data, user_id, media_type)
            .await
    }

    /// Start the long-poll loop. Blocks until stopped.
    pub async fn run(&self) -> Result<()> {
        *self.stopped.write().await = false;
        info!("Long-poll loop started");
        let mut retry_delay = Duration::from_secs(1);

        loop {
            if *self.stopped.read().await {
                break;
            }

            let (base_url, token) = self.get_auth().await?;
            let cursor = self.cursor.read().await.clone();

            match self.client.get_updates(&base_url, &token, &cursor).await {
                Ok(updates) => {
                    if !updates.get_updates_buf.is_empty() {
                        *self.cursor.write().await = updates.get_updates_buf;
                    }
                    retry_delay = Duration::from_secs(1);

                    for wire in &updates.msgs {
                        self.remember_context(wire).await;
                        if let Some(incoming) = IncomingMessage::from_wire(wire) {
                            let handlers = self.handlers.lock().await;
                            for handler in handlers.iter() {
                                handler(&incoming);
                            }
                        }
                    }
                }
                Err(e) if e.is_session_expired() => {
                    warn!("Session expired — re-login required");
                    *self.context_tokens.write().await = HashMap::new();
                    *self.cursor.write().await = String::new();
                    if let Err(e) = self.login(true).await {
                        self.report_error(&e);
                    }
                    continue;
                }
                Err(e) => {
                    self.report_error(&e);
                    sleep(retry_delay).await;
                    retry_delay = std::cmp::min(retry_delay * 2, Duration::from_secs(10));
                    continue;
                }
            }
        }

        info!("Long-poll loop stopped");
        Ok(())
    }

    /// Stop the bot.
    pub async fn stop(&self) {
        *self.stopped.write().await = true;
    }

    // --- internal media ---

    fn send_content<'a>(
        &'a self,
        user_id: &'a str,
        context_token: &'a str,
        content: SendContent,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let (base_url, token) = self.get_auth().await?;
            match content {
                SendContent::Text(text) => self.send_text(user_id, &text, context_token).await,
                SendContent::Image { data, caption } => {
                    let result = self
                        .cdn_upload(&base_url, &token, &data, user_id, 1)
                        .await?;
                    let mut items = Vec::new();
                    if let Some(cap) = caption {
                        items.push(json!({"type": 1, "text_item": {"text": cap}}));
                    }
                    items.push(json!({"type": 2, "image_item": {
                        "media": cdn_media_json(&result.media),
                        "mid_size": result.encrypted_file_size,
                    }}));
                    let msg = protocol::build_media_message(user_id, context_token, items);
                    self.client.send_message(&base_url, &token, &msg).await
                }
                SendContent::Video { data, caption } => {
                    let result = self
                        .cdn_upload(&base_url, &token, &data, user_id, 2)
                        .await?;
                    let mut items = Vec::new();
                    if let Some(cap) = caption {
                        items.push(json!({"type": 1, "text_item": {"text": cap}}));
                    }
                    items.push(json!({"type": 5, "video_item": {
                        "media": cdn_media_json(&result.media),
                        "video_size": result.encrypted_file_size,
                    }}));
                    let msg = protocol::build_media_message(user_id, context_token, items);
                    self.client.send_message(&base_url, &token, &msg).await
                }
                SendContent::File {
                    data,
                    file_name,
                    caption,
                } => {
                    let cat = categorize_by_extension(&file_name);
                    match cat {
                        "image" => {
                            self.send_content(
                                user_id,
                                context_token,
                                SendContent::Image { data, caption },
                            )
                            .await
                        }
                        "video" => {
                            self.send_content(
                                user_id,
                                context_token,
                                SendContent::Video { data, caption },
                            )
                            .await
                        }
                        _ => {
                            if let Some(cap) = caption {
                                self.send_text(user_id, &cap, context_token).await?;
                            }
                            let data_len = data.len();
                            let result = self
                                .cdn_upload(&base_url, &token, &data, user_id, 3)
                                .await?;
                            let items = vec![json!({"type": 4, "file_item": {
                                "media": cdn_media_json(&result.media),
                                "file_name": file_name,
                                "len": data_len.to_string(),
                            }})];
                            let msg = protocol::build_media_message(user_id, context_token, items);
                            self.client.send_message(&base_url, &token, &msg).await
                        }
                    }
                }
            }
        })
    }

    async fn cdn_upload(
        &self,
        base_url: &str,
        token: &str,
        data: &[u8],
        user_id: &str,
        media_type: i32,
    ) -> Result<UploadResult> {
        let aes_key = crypto::generate_aes_key();
        let ciphertext = crypto::encrypt_aes_ecb(data, &aes_key);

        let mut filekey_buf = [0u8; 16];
        rand::rng().fill_bytes(&mut filekey_buf);
        let filekey = hex::encode(filekey_buf);

        let raw_md5 = hex::encode(Md5::digest(data));

        let params = protocol::GetUploadUrlParams {
            filekey: filekey.clone(),
            media_type,
            to_user_id: user_id.to_string(),
            rawsize: data.len(),
            rawfilemd5: raw_md5,
            filesize: ciphertext.len(),
            no_need_thumb: true,
            aeskey: crypto::encode_aes_key_hex(&aes_key),
        };

        let upload_resp = self.client.get_upload_url(base_url, token, &params).await?;
        let upload_param = upload_resp.upload_param.ok_or_else(|| {
            WeChatBotError::Media("getuploadurl did not return upload_param".into())
        })?;

        let upload_url =
            protocol::build_cdn_upload_url(protocol::CDN_BASE_URL, &upload_param, &filekey);

        let encrypted_file_size = ciphertext.len();

        let encrypt_query_param = self.client.upload_to_cdn(&upload_url, &ciphertext).await?;

        Ok(UploadResult {
            media: CDNMedia {
                encrypt_query_param,
                aes_key: crypto::encode_aes_key_base64(&aes_key),
                encrypt_type: Some(1),
                full_url: None,
            },
            aes_key,
            encrypted_file_size,
        })
    }

    // --- internal text ---

    async fn send_text(&self, user_id: &str, text: &str, context_token: &str) -> Result<()> {
        let (base_url, token) = self.get_auth().await?;
        for chunk in chunk_text(text, 4000) {
            let msg = protocol::build_text_message(user_id, context_token, &chunk);
            self.client.send_message(&base_url, &token, &msg).await?;
        }
        Ok(())
    }

    async fn remember_context(&self, wire: &WireMessage) {
        let user_id = if wire.message_type == MessageType::User {
            &wire.from_user_id
        } else {
            &wire.to_user_id
        };
        if !user_id.is_empty() && !wire.context_token.is_empty() {
            self.context_tokens
                .write()
                .await
                .insert(user_id.clone(), wire.context_token.clone());
        }
    }

    async fn get_auth(&self) -> Result<(String, String)> {
        let creds = self.credentials.read().await;
        let creds = creds
            .as_ref()
            .ok_or_else(|| WeChatBotError::Auth("not logged in".into()))?;
        Ok((creds.base_url.clone(), creds.token.clone()))
    }

    async fn load_credentials(&self) -> Result<Option<Credentials>> {
        let path = self.cred_path.clone().unwrap_or_else(default_cred_path);
        match tokio::fs::read_to_string(&path).await {
            Ok(data) => Ok(Some(serde_json::from_str(&data)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    async fn save_credentials(&self, creds: &Credentials) -> Result<()> {
        let path = self.cred_path.clone().unwrap_or_else(default_cred_path);
        let dir = std::path::Path::new(&path).parent().unwrap();
        tokio::fs::create_dir_all(dir).await?;
        let data = serde_json::to_string_pretty(creds)?;
        tokio::fs::write(&path, format!("{}\n", data)).await?;
        Ok(())
    }

    fn report_error(&self, err: &WeChatBotError) {
        error!("{}", err);
        if let Some(ref cb) = self.on_error {
            cb(err);
        }
    }
}

/// Content to send via reply_media / send_media.
pub enum SendContent {
    Text(String),
    Image {
        data: Vec<u8>,
        caption: Option<String>,
    },
    Video {
        data: Vec<u8>,
        caption: Option<String>,
    },
    File {
        data: Vec<u8>,
        file_name: String,
        caption: Option<String>,
    },
}

fn cdn_media_json(media: &CDNMedia) -> serde_json::Value {
    let mut v = json!({
        "encrypt_query_param": media.encrypt_query_param,
        "aes_key": media.aes_key,
    });
    if let Some(et) = media.encrypt_type {
        v["encrypt_type"] = json!(et);
    }
    v
}

fn categorize_by_extension(filename: &str) -> &'static str {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" => "image",
        "mp4" | "mov" | "webm" | "mkv" | "avi" => "video",
        _ => "file",
    }
}

fn chunk_text(text: &str, limit: usize) -> Vec<String> {
    if text.len() <= limit {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut remaining = text;
    while !remaining.is_empty() {
        if remaining.len() <= limit {
            chunks.push(remaining.to_string());
            break;
        }
        let window = &remaining[..limit];
        let cut = window
            .rfind("\n\n")
            .filter(|&i| i > limit * 3 / 10)
            .map(|i| i + 2)
            .or_else(|| {
                window
                    .rfind('\n')
                    .filter(|&i| i > limit * 3 / 10)
                    .map(|i| i + 1)
            })
            .or_else(|| {
                window
                    .rfind(' ')
                    .filter(|&i| i > limit * 3 / 10)
                    .map(|i| i + 1)
            })
            .unwrap_or(limit);
        chunks.push(remaining[..cut].to_string());
        remaining = &remaining[cut..];
    }
    if chunks.is_empty() {
        vec![String::new()]
    } else {
        chunks
    }
}

fn default_cred_path() -> String {
    let home = dirs_next::home_dir().unwrap_or_else(|| ".".into());
    home.join(".wechatbot")
        .join("credentials.json")
        .to_string_lossy()
        .to_string()
}

fn chrono_now() -> String {
    // Simple ISO 8601 without chrono dependency
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    format!("{}Z", dur.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_text_short() {
        let chunks = chunk_text("hello", 100);
        assert_eq!(chunks, vec!["hello"]);
    }

    #[test]
    fn chunk_text_empty() {
        let chunks = chunk_text("", 100);
        assert_eq!(chunks, vec![""]);
    }

    #[test]
    fn chunk_text_splits_on_paragraph() {
        let text = "aaaa\n\nbbbb";
        let chunks = chunk_text(text, 7);
        assert_eq!(chunks, vec!["aaaa\n\n", "bbbb"]);
    }

    #[test]
    fn chunk_text_splits_on_newline() {
        let text = "aaaa\nbbbb";
        let chunks = chunk_text(text, 7);
        assert_eq!(chunks, vec!["aaaa\n", "bbbb"]);
    }

    #[test]
    fn chunk_text_exact_limit() {
        let text = "abcdef";
        let chunks = chunk_text(text, 6);
        assert_eq!(chunks, vec!["abcdef"]);
    }

    #[test]
    fn default_cred_path_not_empty() {
        let path = default_cred_path();
        assert!(!path.is_empty());
        assert!(path.contains(".wechatbot"));
        assert!(path.contains("credentials.json"));
    }

    #[test]
    fn categorize_image_extensions() {
        assert_eq!(categorize_by_extension("photo.png"), "image");
        assert_eq!(categorize_by_extension("photo.JPG"), "image");
        assert_eq!(categorize_by_extension("anim.gif"), "image");
        assert_eq!(categorize_by_extension("pic.webp"), "image");
    }

    #[test]
    fn categorize_video_extensions() {
        assert_eq!(categorize_by_extension("clip.mp4"), "video");
        assert_eq!(categorize_by_extension("clip.MOV"), "video");
        assert_eq!(categorize_by_extension("movie.webm"), "video");
    }

    #[test]
    fn categorize_file_extensions() {
        assert_eq!(categorize_by_extension("report.pdf"), "file");
        assert_eq!(categorize_by_extension("data.csv"), "file");
        assert_eq!(categorize_by_extension("noext"), "file");
    }

    #[test]
    fn cdn_media_json_with_encrypt_type() {
        let media = CDNMedia {
            encrypt_query_param: "param=1".to_string(),
            aes_key: "key123".to_string(),
            encrypt_type: Some(1),
            full_url: None,
        };
        let j = cdn_media_json(&media);
        assert_eq!(j["encrypt_query_param"], "param=1");
        assert_eq!(j["aes_key"], "key123");
        assert_eq!(j["encrypt_type"], 1);
    }

    #[test]
    fn cdn_media_json_without_encrypt_type() {
        let media = CDNMedia {
            encrypt_query_param: "p".to_string(),
            aes_key: "k".to_string(),
            encrypt_type: None,
            full_url: None,
        };
        let j = cdn_media_json(&media);
        assert!(j.get("encrypt_type").is_none());
    }
}
