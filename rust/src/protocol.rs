//! Raw iLink Bot API HTTP calls.

use base64::Engine;
use rand::RngCore;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

use crate::error::{Result, WeChatBotError};
use crate::types::*;

pub const DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
pub const CDN_BASE_URL: &str = "https://novac2c.cdn.weixin.qq.com/c2c";
pub const CHANNEL_VERSION: &str = "2.0.0";

/// Generate the X-WECHAT-UIN header value.
pub fn random_wechat_uin() -> String {
    let mut buf = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut buf);
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
}

/// Get updates response.
#[derive(Debug, Deserialize)]
pub struct GetUpdatesResponse {
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
pub struct ILinkClient {
    http: Client,
}

impl ILinkClient {
    pub fn new() -> Self {
        Self {
            http: Client::builder()
                .timeout(Duration::from_secs(45))
                .build()
                .unwrap(),
        }
    }

    pub async fn get_qr_code(&self, base_url: &str) -> Result<QrCodeResponse> {
        let url = format!("{}/ilink/bot/get_bot_qrcode?bot_type=3", base_url);
        let resp = self.http.get(&url).send().await?;
        Ok(resp.json().await?)
    }

    pub async fn poll_qr_status(&self, base_url: &str, qrcode: &str) -> Result<QrStatusResponse> {
        let url = format!(
            "{}/ilink/bot/get_qrcode_status?qrcode={}",
            base_url,
            urlencoding::encode(qrcode)
        );
        let resp = self
            .http
            .get(&url)
            .header("iLink-App-ClientVersion", "1")
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
            "base_info": { "channel_version": CHANNEL_VERSION }
        });
        let resp = self.api_post(base_url, "/ilink/bot/getupdates", token, &body, 45).await?;
        let result: GetUpdatesResponse = serde_json::from_value(resp)?;
        if result.ret != 0 {
            let code = result.errcode.unwrap_or(result.ret);
            let msg = result.errmsg.unwrap_or_else(|| format!("ret={}", result.ret));
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
            "base_info": { "channel_version": CHANNEL_VERSION }
        });
        self.api_post(base_url, "/ilink/bot/sendmessage", token, &body, 15).await?;
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
            "base_info": { "channel_version": CHANNEL_VERSION }
        });
        let resp = self.api_post(base_url, "/ilink/bot/getconfig", token, &body, 15).await?;
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
            "base_info": { "channel_version": CHANNEL_VERSION }
        });
        self.api_post(base_url, "/ilink/bot/sendtyping", token, &body, 15).await?;
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
            .json(body)
            .send()
            .await?;

        let status = resp.status().as_u16();
        let text = resp.text().await?;
        let value: Value = serde_json::from_str(&text).unwrap_or(json!({}));

        if status >= 400 {
            return Err(WeChatBotError::Api {
                message: value["errmsg"].as_str().unwrap_or(&text).to_string(),
                http_status: status,
                errcode: value["errcode"].as_i64().unwrap_or(0) as i32,
            });
        }

        Ok(value)
    }
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
