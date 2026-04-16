//! Low-level CDN client for direct media download.
//!
//! [`CdnClient`] is a primitive layer that can be used independently of
//! [`WeChatBot`](crate::WeChatBot), e.g. when you drive `get_updates` yourself
//! via [`ILinkClient`](crate::protocol::ILinkClient) and only need decryption
//! for a specific attachment.
//!
//! Modeled after [`teloxide_core::Bot`]: wraps a [`reqwest::Client`] so
//! connection pool / TLS session / DNS cache are reused across calls, and is
//! cheap to [`Clone`].

use reqwest::Client;
use std::time::Duration;

use crate::crypto;
use crate::error::{Result, WeChatBotError};
use crate::protocol::CDN_BASE_URL;
use crate::types::CDNMedia;

/// HTTP client for WeChat CDN media endpoints.
///
/// Cheap to [`Clone`] — shares the underlying [`reqwest::Client`], which uses
/// an `Arc` internally.
///
/// # Example
///
/// ```no_run
/// use wechatbot::{CdnClient, CDNMedia};
///
/// # async fn demo(media: CDNMedia) -> Result<(), Box<dyn std::error::Error>> {
/// let cdn = CdnClient::new();
/// let bytes = cdn.download(&media, None).await?;
/// # Ok(())
/// # }
/// ```
#[derive(Debug, Clone)]
pub struct CdnClient {
    http: Client,
    base_url: String,
}

impl Default for CdnClient {
    fn default() -> Self {
        Self::new()
    }
}

impl CdnClient {
    /// Create a [`CdnClient`] with a fresh internal [`reqwest::Client`].
    pub fn new() -> Self {
        Self::with_client(Client::new())
    }

    /// Create a [`CdnClient`] that reuses an existing [`reqwest::Client`].
    ///
    /// Useful when the caller already maintains a shared HTTP client with
    /// custom proxy / TLS / timeout configuration.
    pub fn with_client(http: Client) -> Self {
        Self {
            http,
            base_url: CDN_BASE_URL.to_string(),
        }
    }

    /// Override the CDN base URL (defaults to [`CDN_BASE_URL`]).
    ///
    /// Primarily intended for tests and regional endpoints.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    /// Download and AES-decrypt a CDN media object.
    ///
    /// `aes_key_override` is used when the decryption key is attached to the
    /// message metadata (e.g. [`ImageContent::aes_key`](crate::ImageContent::aes_key))
    /// rather than embedded in the media's own `aes_key` field.
    pub async fn download(
        &self,
        media: &CDNMedia,
        aes_key_override: Option<&str>,
    ) -> Result<Vec<u8>> {
        let download_url = format!(
            "{}/download?encrypted_query_param={}",
            self.base_url,
            urlencoding::encode(&media.encrypt_query_param)
        );

        let resp = self
            .http
            .get(&download_url)
            .timeout(Duration::from_secs(60))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(WeChatBotError::Media(format!(
                "CDN download failed: HTTP {}",
                resp.status()
            )));
        }

        let ciphertext = resp.bytes().await?.to_vec();

        let key_source = aes_key_override.unwrap_or(&media.aes_key);
        if key_source.is_empty() {
            return Err(WeChatBotError::Media("no AES key available".into()));
        }

        let aes_key = crypto::decode_aes_key(key_source)?;
        crypto::decrypt_aes_ecb(&ciphertext, &aes_key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_new_equivalent() {
        let a = CdnClient::default();
        let b = CdnClient::new();
        assert_eq!(a.base_url, b.base_url);
    }

    #[test]
    fn with_base_url_overrides() {
        let c = CdnClient::new().with_base_url("https://example.test/cdn");
        assert_eq!(c.base_url, "https://example.test/cdn");
    }

    #[test]
    fn clone_is_cheap_and_preserves_config() {
        let c = CdnClient::new().with_base_url("https://x.y/z");
        let cloned = c.clone();
        assert_eq!(c.base_url, cloned.base_url);
    }
}
