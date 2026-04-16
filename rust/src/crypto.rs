//! AES-128-ECB encryption for WeChat CDN media files.

use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes::Aes128;
use base64::Engine;
use rand::Rng;

use crate::error::{Result, WeChatBotError};

/// Encrypt plaintext with AES-128-ECB and PKCS7 padding.
pub fn encrypt_aes_ecb(plaintext: &[u8], key: &[u8; 16]) -> Vec<u8> {
    let cipher = Aes128::new(key.into());
    let padded = pkcs7_pad(plaintext, 16);
    let mut ciphertext = padded;
    for chunk in ciphertext.chunks_exact_mut(16) {
        cipher.encrypt_block(chunk.into());
    }
    ciphertext
}

/// Decrypt AES-128-ECB ciphertext and remove PKCS7 padding.
pub fn decrypt_aes_ecb(ciphertext: &[u8], key: &[u8; 16]) -> Result<Vec<u8>> {
    if ciphertext.len() % 16 != 0 {
        return Err(WeChatBotError::Media(
            "ciphertext length not a multiple of 16".into(),
        ));
    }
    let cipher = Aes128::new(key.into());
    let mut plaintext = ciphertext.to_vec();
    for chunk in plaintext.chunks_exact_mut(16) {
        cipher.decrypt_block(chunk.into());
    }
    pkcs7_unpad(&plaintext)
}

/// Generate a random 16-byte AES key.
pub fn generate_aes_key() -> [u8; 16] {
    let mut key = [0u8; 16];
    rand::rng().fill_bytes(&mut key);
    key
}

/// Calculate encrypted size with PKCS7 padding.
pub fn encrypted_size(raw_size: usize) -> usize {
    ((raw_size + 1 + 15) / 16) * 16
}

/// Decode an aes_key from the protocol (handles all three formats).
pub fn decode_aes_key(encoded: &str) -> Result<[u8; 16]> {
    // Direct hex (32 chars)
    if encoded.len() == 32 && encoded.chars().all(|c| c.is_ascii_hexdigit()) {
        let bytes =
            hex::decode(encoded).map_err(|e| WeChatBotError::Media(format!("hex decode: {e}")))?;
        return bytes_to_key(&bytes);
    }

    // Base64 decode
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(encoded))
        .map_err(|e| WeChatBotError::Media(format!("base64 decode: {e}")))?;

    if decoded.len() == 16 {
        return bytes_to_key(&decoded);
    }

    if decoded.len() == 32 {
        let hex_str = std::str::from_utf8(&decoded)
            .map_err(|_| WeChatBotError::Media("decoded key is not UTF-8".into()))?;
        if hex_str.chars().all(|c| c.is_ascii_hexdigit()) {
            let bytes = hex::decode(hex_str)
                .map_err(|e| WeChatBotError::Media(format!("hex decode: {e}")))?;
            return bytes_to_key(&bytes);
        }
    }

    Err(WeChatBotError::Media(format!(
        "unexpected decoded key length: {}",
        decoded.len()
    )))
}

/// Encode an AES key as hex (for getuploadurl).
pub fn encode_aes_key_hex(key: &[u8; 16]) -> String {
    hex::encode(key)
}

/// Encode an AES key as base64(hex) (for CDNMedia.aes_key).
pub fn encode_aes_key_base64(key: &[u8; 16]) -> String {
    base64::engine::general_purpose::STANDARD.encode(hex::encode(key))
}

fn bytes_to_key(bytes: &[u8]) -> Result<[u8; 16]> {
    bytes
        .try_into()
        .map_err(|_| WeChatBotError::Media(format!("key length {} != 16", bytes.len())))
}

fn pkcs7_pad(data: &[u8], block_size: usize) -> Vec<u8> {
    let padding = block_size - (data.len() % block_size);
    let mut result = data.to_vec();
    result.extend(std::iter::repeat(padding as u8).take(padding));
    result
}

fn pkcs7_unpad(data: &[u8]) -> Result<Vec<u8>> {
    if data.is_empty() {
        return Err(WeChatBotError::Media("empty data".into()));
    }
    let padding = *data.last().unwrap() as usize;
    if padding == 0 || padding > data.len() || padding > 16 {
        return Err(WeChatBotError::Media("invalid PKCS7 padding".into()));
    }
    Ok(data[..data.len() - padding].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let key = generate_aes_key();
        let plaintext = b"Hello, WeChat!";
        let ct = encrypt_aes_ecb(plaintext, &key);
        let pt = decrypt_aes_ecb(&ct, &key).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn encrypted_size_calc() {
        assert_eq!(encrypted_size(14), 16);
        assert_eq!(encrypted_size(16), 32);
        assert_eq!(encrypted_size(100), 112);
    }

    #[test]
    fn decode_direct_hex() {
        let key = decode_aes_key("00112233445566778899aabbccddeeff").unwrap();
        assert_eq!(key.len(), 16);
    }

    #[test]
    fn decode_base64_raw() {
        let key = decode_aes_key("ABEiM0RVZneImaq7zN3u/w==").unwrap();
        assert_eq!(key.len(), 16);
    }
}
