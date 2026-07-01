//! Raw iLink Bot API HTTP calls.

use base64::Engine;
use rand::Rng;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

use crate::error::{Result, WeChatBotError};
#[allow(unused_imports)]
use crate::types::*;

pub const DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
pub const CDN_BASE_URL: &str = "https://novac2c.cdn.weixin.qq.com/c2c";
pub const CHANNEL_VERSION: &str = env!("CARGO_PKG_VERSION");

/// iLink-App-Id header value.
const ILINK_APP_ID: &str = "bot";

/// Build iLink-App-ClientVersion from the crate version (0x00MMNNPP).
fn build_client_version() -> String {
    let version = env!("CARGO_PKG_VERSION");
    let parts: Vec<u32> = version.split('.').filter_map(|p| p.parse().ok()).collect();
    let major = parts.first().copied().unwrap_or(0) & 0xff;
    let minor = parts.get(1).copied().unwrap_or(0) & 0xff;
    let patch = parts.get(2).copied().unwrap_or(0) & 0xff;
    let num = (major << 16) | (minor << 8) | patch;
    num.to_string()
}

/// Default `bot_agent` when none is configured or the configured value is invalid.
pub fn default_bot_agent() -> String {
    format!("WeChatBot/{}", CHANNEL_VERSION)
}

/// Maximum length (bytes) of the sanitized `bot_agent` string.
const BOT_AGENT_MAX_LEN: usize = 256;

fn is_valid_product(tok: &str) -> bool {
    let Some((name, version)) = tok.split_once('/') else {
        return false;
    };
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        && (1..=32).contains(&version.len())
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'))
}

/// Validate a user-supplied `bot_agent` into a wire-safe string.
///
/// UA-style grammar (matches openclaw-weixin):
///   bot_agent = product *( SP product )
///   product   = name "/" version [ SP "(" comment ")" ]
///   name      = 1*32( ALPHA / DIGIT / "_" / "." / "-" )
///   version   = 1*32( ALPHA / DIGIT / "_" / "." / "+" / "-" )
///   comment   = 1*64( printable ASCII minus "(" ")" )
///
/// Unlike upstream openclaw-weixin (which salvages the valid tokens out of a
/// partially invalid string), any invalid input falls back to
/// `default_bot_agent()` wholesale — simpler and just as safe on the wire.
pub fn sanitize_bot_agent(raw: Option<&str>) -> String {
    let default = default_bot_agent();
    let Some(raw) = raw else { return default };

    // Normalize whitespace, keeping multi-word "(comment)" tokens intact.
    let mut tokens: Vec<String> = Vec::new();
    let mut in_comment = false;
    for word in raw.split_whitespace() {
        if in_comment {
            let last = tokens.last_mut().expect("comment follows a token");
            last.push(' ');
            last.push_str(word);
            in_comment = !word.ends_with(')');
        } else {
            tokens.push(word.to_string());
            in_comment = word.starts_with('(') && !word.ends_with(')');
        }
    }
    if tokens.is_empty() || in_comment {
        return default;
    }

    // Validate: each token is a product, or a "(comment)" directly after one.
    let mut prev_was_product = false;
    for tok in &tokens {
        if tok.starts_with('(') && tok.ends_with(')') && tok.len() >= 2 {
            let inner = &tok[1..tok.len() - 1];
            let ok = prev_was_product
                && (1..=64).contains(&inner.len())
                && inner
                    .bytes()
                    .all(|b| (0x20..=0x7e).contains(&b) && b != b'(' && b != b')');
            if !ok {
                return default;
            }
            prev_was_product = false;
        } else if is_valid_product(tok) {
            prev_was_product = true;
        } else {
            return default;
        }
    }

    let joined = tokens.join(" ");
    if joined.len() > BOT_AGENT_MAX_LEN {
        return default;
    }
    joined
}

#[cfg(test)]
mod bot_agent_tests {
    use super::*;

    #[test]
    fn empty_input_falls_back_to_default() {
        assert_eq!(sanitize_bot_agent(None), default_bot_agent());
        assert_eq!(sanitize_bot_agent(Some("")), default_bot_agent());
        assert_eq!(sanitize_bot_agent(Some("   ")), default_bot_agent());
    }

    #[test]
    fn valid_agents_pass_through() {
        assert_eq!(sanitize_bot_agent(Some("MyApp/1.2")), "MyApp/1.2");
        assert_eq!(
            sanitize_bot_agent(Some("MyApp/1.2 (prod build)")),
            "MyApp/1.2 (prod build)"
        );
        assert_eq!(
            sanitize_bot_agent(Some("MyApp/1.2 (prod) Lib/0.3")),
            "MyApp/1.2 (prod) Lib/0.3"
        );
        assert_eq!(
            sanitize_bot_agent(Some("  MyApp/1.2   Lib/0.3 ")),
            "MyApp/1.2 Lib/0.3"
        );
    }

    #[test]
    fn invalid_agents_fall_back_wholesale() {
        for bad in [
            "no-slash",
            "bad name/1.0 !!!",
            "(orphan comment)",
            "App/1.0 (unclosed",
            "App/1.0 (nested (comment))",
        ] {
            assert_eq!(sanitize_bot_agent(Some(bad)), default_bot_agent(), "{bad}");
        }
        let long_name = format!("{}/1.0", "a".repeat(33));
        assert_eq!(sanitize_bot_agent(Some(&long_name)), default_bot_agent());
        let over_cap = "App/1.0 ".repeat(40);
        assert_eq!(
            sanitize_bot_agent(Some(over_cap.trim())),
            default_bot_agent()
        );
    }
}

/// Generate the X-WECHAT-UIN header value.
pub fn random_wechat_uin() -> String {
    let mut buf = [0u8; 4];
    rand::rng().fill_bytes(&mut buf);
    let val = u32::from_be_bytes(buf);
    base64::engine::general_purpose::STANDARD.encode(val.to_string())
}

/// QR code response.
#[derive(Debug, Deserialize)]
pub struct QrCodeResponse {
    pub qrcode: String,
    pub qrcode_img_content: String,
}

/// QR status response.
#[derive(Debug, Deserialize)]
pub struct QrStatusResponse {
    pub status: String,
    pub bot_token: Option<String>,
    pub ilink_bot_id: Option<String>,
    pub ilink_user_id: Option<String>,
    pub baseurl: Option<String>,
    /// New host to redirect polling to when status is "scaned_but_redirect".
    pub redirect_host: Option<String>,
}

/// Get updates response.
#[derive(Debug, Deserialize)]
pub struct GetUpdatesResponse {
    #[serde(default)]
    pub ret: i32,
    #[serde(default)]
    pub msgs: Vec<WireMessage>,
    #[serde(default)]
    pub get_updates_buf: String,
    pub errcode: Option<i32>,
    pub errmsg: Option<String>,
}

/// Get config response.
#[derive(Debug, Deserialize)]
pub struct GetConfigResponse {
    pub typing_ticket: Option<String>,
}

/// Low-level iLink API client.
#[derive(Debug)]
pub struct ILinkClient {
    http: Client,
    bot_agent: String,
}

impl ILinkClient {
    pub fn new() -> Self {
        Self::with_bot_agent(None)
    }

    /// Create a client with a custom `bot_agent` (sent as `base_info.bot_agent`
    /// on every API request). Invalid values fall back to `default_bot_agent()`.
    pub fn with_bot_agent(bot_agent: Option<&str>) -> Self {
        Self {
            http: Client::builder()
                .timeout(Duration::from_secs(45))
                .build()
                .unwrap(),
            bot_agent: sanitize_bot_agent(bot_agent),
        }
    }

    fn base_info(&self) -> Value {
        json!({ "channel_version": CHANNEL_VERSION, "bot_agent": self.bot_agent })
    }

    /// Request a login QR code.
    ///
    /// `local_token_list` carries up to 10 known local bot tokens (newest
    /// first) so the server can answer `binded_redirect` for an already-bound
    /// bot instead of issuing a duplicate session.
    pub async fn get_qr_code(
        &self,
        base_url: &str,
        local_token_list: &[String],
    ) -> Result<QrCodeResponse> {
        let url = format!("{}/ilink/bot/get_bot_qrcode?bot_type=3", base_url);
        let resp = self
            .http
            .post(&url)
            .header("Content-Type", "application/json")
            .header("iLink-App-Id", ILINK_APP_ID)
            .header("iLink-App-ClientVersion", build_client_version())
            .json(&json!({ "local_token_list": local_token_list }))
            .send()
            .await?;
        Ok(resp.json().await?)
    }

    /// Poll the QR scan status.
    ///
    /// `verify_code` submits a pairing code after the server answered
    /// `need_verifycode` (the digits shown in WeChat on the user's phone).
    pub async fn poll_qr_status(
        &self,
        base_url: &str,
        qrcode: &str,
        verify_code: Option<&str>,
    ) -> Result<QrStatusResponse> {
        let mut url = format!(
            "{}/ilink/bot/get_qrcode_status?qrcode={}",
            base_url,
            urlencoding::encode(qrcode)
        );
        if let Some(code) = verify_code {
            url.push_str(&format!("&verify_code={}", urlencoding::encode(code)));
        }
        let resp = self
            .http
            .get(&url)
            .header("iLink-App-Id", ILINK_APP_ID)
            .header("iLink-App-ClientVersion", build_client_version())
            .send()
            .await?;
        Ok(resp.json().await?)
    }

    pub async fn get_updates(
        &self,
        base_url: &str,
        token: &str,
        cursor: &str,
    ) -> Result<GetUpdatesResponse> {
        let body = json!({
            "get_updates_buf": cursor,
            "base_info": self.base_info()
        });
        let resp = self
            .api_post(base_url, "/ilink/bot/getupdates", token, &body, 45)
            .await?;
        let result: GetUpdatesResponse = serde_json::from_value(resp)?;
        if result.ret != 0 || result.errcode.is_some_and(|c| c != 0) {
            let code = result.errcode.unwrap_or(result.ret);
            let msg = result
                .errmsg
                .unwrap_or_else(|| format!("ret={}", result.ret));
            return Err(WeChatBotError::Api {
                message: msg,
                http_status: 200,
                errcode: code,
            });
        }
        Ok(result)
    }

    pub async fn send_message(&self, base_url: &str, token: &str, msg: &Value) -> Result<()> {
        let body = json!({
            "msg": msg,
            "base_info": self.base_info()
        });
        self.api_post(base_url, "/ilink/bot/sendmessage", token, &body, 15)
            .await?;
        Ok(())
    }

    pub async fn get_config(
        &self,
        base_url: &str,
        token: &str,
        user_id: &str,
        context_token: &str,
    ) -> Result<GetConfigResponse> {
        let body = json!({
            "ilink_user_id": user_id,
            "context_token": context_token,
            "base_info": self.base_info()
        });
        let resp = self
            .api_post(base_url, "/ilink/bot/getconfig", token, &body, 15)
            .await?;
        Ok(serde_json::from_value(resp)?)
    }

    pub async fn send_typing(
        &self,
        base_url: &str,
        token: &str,
        user_id: &str,
        ticket: &str,
        status: i32,
    ) -> Result<()> {
        let body = json!({
            "ilink_user_id": user_id,
            "typing_ticket": ticket,
            "status": status,
            "base_info": self.base_info()
        });
        self.api_post(base_url, "/ilink/bot/sendtyping", token, &body, 15)
            .await?;
        Ok(())
    }

    async fn api_post(
        &self,
        base_url: &str,
        endpoint: &str,
        token: &str,
        body: &Value,
        timeout_secs: u64,
    ) -> Result<Value> {
        let url = format!("{}{}", base_url, endpoint);
        let resp = self
            .http
            .post(&url)
            .timeout(Duration::from_secs(timeout_secs))
            .header("Content-Type", "application/json")
            .header("AuthorizationType", "ilink_bot_token")
            .header("Authorization", format!("Bearer {}", token))
            .header("X-WECHAT-UIN", random_wechat_uin())
            .header("iLink-App-Id", ILINK_APP_ID)
            .header("iLink-App-ClientVersion", build_client_version())
            .json(body)
            .send()
            .await?;

        let status = resp.status().as_u16();
        let text = resp.text().await?;
        let value: Value = serde_json::from_str(&text).unwrap_or(json!({}));

        if status >= 400 {
            return Err(WeChatBotError::Api {
                message: value["errmsg"]
                    .as_str()
                    .or_else(|| value["message"].as_str())
                    .unwrap_or(&text)
                    .to_string(),
                http_status: status,
                errcode: value["errcode"].as_i64().unwrap_or(0) as i32,
            });
        }

        if let Some(errcode) = value["errcode"].as_i64() {
            if errcode != 0 {
                return Err(WeChatBotError::Api {
                    message: value["errmsg"]
                        .as_str()
                        .or_else(|| value["message"].as_str())
                        .unwrap_or(&text)
                        .to_string(),
                    http_status: status,
                    errcode: errcode as i32,
                });
            }
        }

        Ok(value)
    }
}

/// Build a media message payload.
pub fn build_media_message(user_id: &str, context_token: &str, item_list: Vec<Value>) -> Value {
    json!({
        "from_user_id": "",
        "to_user_id": user_id,
        "client_id": Uuid::new_v4().to_string(),
        "message_type": 2,
        "message_state": 2,
        "context_token": context_token,
        "item_list": item_list
    })
}

/// GetUploadUrl request parameters.
pub struct GetUploadUrlParams {
    pub filekey: String,
    pub media_type: i32,
    pub to_user_id: String,
    pub rawsize: usize,
    pub rawfilemd5: String,
    pub filesize: usize,
    pub no_need_thumb: bool,
    pub aeskey: String,
}

/// GetUploadUrl response.
#[derive(Debug, Deserialize)]
pub struct GetUploadUrlResponse {
    pub upload_param: Option<String>,
    pub thumb_upload_param: Option<String>,
    pub upload_full_url: Option<String>,
}

impl ILinkClient {
    /// Get a pre-signed CDN upload URL.
    pub async fn get_upload_url(
        &self,
        base_url: &str,
        token: &str,
        params: &GetUploadUrlParams,
    ) -> Result<GetUploadUrlResponse> {
        let body = json!({
            "filekey": params.filekey,
            "media_type": params.media_type,
            "to_user_id": params.to_user_id,
            "rawsize": params.rawsize,
            "rawfilemd5": params.rawfilemd5,
            "filesize": params.filesize,
            "no_need_thumb": params.no_need_thumb,
            "aeskey": params.aeskey,
            "base_info": self.base_info()
        });
        let resp = self
            .api_post(base_url, "/ilink/bot/getuploadurl", token, &body, 15)
            .await?;
        Ok(serde_json::from_value(resp)?)
    }

    /// Upload encrypted bytes to CDN with retry (up to 3 attempts).
    /// Returns the download encrypted_query_param from the x-encrypted-param header.
    pub async fn upload_to_cdn(&self, cdn_url: &str, ciphertext: &[u8]) -> Result<String> {
        const MAX_RETRIES: u32 = 3;
        let mut last_err = None;

        for attempt in 1..=MAX_RETRIES {
            match self
                .http
                .post(cdn_url)
                .header("Content-Type", "application/octet-stream")
                .body(ciphertext.to_vec())
                .send()
                .await
            {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if status >= 400 && status < 500 {
                        let err_msg = resp
                            .headers()
                            .get("x-error-message")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("client error")
                            .to_string();
                        return Err(WeChatBotError::Media(format!(
                            "CDN upload client error {}: {}",
                            status, err_msg
                        )));
                    }
                    if status != 200 {
                        let err_msg = resp
                            .headers()
                            .get("x-error-message")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("server error")
                            .to_string();
                        last_err = Some(WeChatBotError::Media(format!(
                            "CDN upload server error {}: {}",
                            status, err_msg
                        )));
                        continue;
                    }
                    match resp
                        .headers()
                        .get("x-encrypted-param")
                        .and_then(|v| v.to_str().ok())
                    {
                        Some(param) => return Ok(param.to_string()),
                        None => {
                            last_err = Some(WeChatBotError::Media(
                                "CDN upload response missing x-encrypted-param header".into(),
                            ));
                            continue;
                        }
                    }
                }
                Err(e) => {
                    last_err = Some(WeChatBotError::Other(format!(
                        "CDN upload network error: {}",
                        e
                    )));
                    if attempt < MAX_RETRIES {
                        continue;
                    }
                }
            }
        }
        Err(last_err.unwrap_or_else(|| {
            WeChatBotError::Media(format!("CDN upload failed after {} attempts", MAX_RETRIES))
        }))
    }
}

/// Build a CDN upload URL from params.
pub fn build_cdn_upload_url(cdn_base_url: &str, upload_param: &str, filekey: &str) -> String {
    format!(
        "{}/upload?encrypted_query_param={}&filekey={}",
        cdn_base_url,
        urlencoding::encode(upload_param),
        urlencoding::encode(filekey)
    )
}

/// Build a text message payload.
pub fn build_text_message(user_id: &str, context_token: &str, text: &str) -> Value {
    json!({
        "from_user_id": "",
        "to_user_id": user_id,
        "client_id": Uuid::new_v4().to_string(),
        "message_type": 2,
        "message_state": 2,
        "context_token": context_token,
        "item_list": [{ "type": 1, "text_item": { "text": text } }]
    })
}
