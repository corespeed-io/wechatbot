//! # wechatbot
//!
//! WeChat iLink Bot SDK for Rust.
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use wechatbot::{WeChatBot, BotOptions};
//!
//! #[tokio::main]
//! async fn main() {
//!     let bot = WeChatBot::new(BotOptions::default());
//!     bot.login(false).await.unwrap();
//!
//!     bot.on_message(Box::new(|msg| {
//!         println!("{}: {}", msg.user_id, msg.text);
//!     })).await;
//!
//!     bot.run().await.unwrap();
//! }
//! ```

pub mod bot;
pub mod crypto;
pub mod error;
pub mod protocol;
pub mod types;

pub use bot::{BotOptions, MessageHandler, SendContent, WeChatBot};
pub use crypto::{decrypt_aes_ecb, decrypt_aes_ecb as download_decrypt, encode_aes_key_base64, encode_aes_key_hex, encrypt_aes_ecb, generate_aes_key, decode_aes_key};
pub use error::{Result, WeChatBotError};
pub use types::*;
