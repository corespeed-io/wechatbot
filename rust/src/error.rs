use thiserror::Error;

/// Errors that can occur in the SDK.
#[derive(Error, Debug)]
pub enum WeChatBotError {
    #[error("API error: {message} (http={http_status}, errcode={errcode})")]
    Api {
        message: String,
        http_status: u16,
        errcode: i32,
    },

    #[error("Auth error: {0}")]
    Auth(String),

    #[error("No context_token for user {0}")]
    NoContext(String),

    #[error("Media error: {0}")]
    Media(String),

    #[error("Transport error: {0}")]
    Transport(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

impl WeChatBotError {
    /// Returns true if this is a session-expired error (errcode -14).
    pub fn is_session_expired(&self) -> bool {
        matches!(self, WeChatBotError::Api { errcode: -14, .. })
    }
}

pub type Result<T> = std::result::Result<T, WeChatBotError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_expired_true() {
        let err = WeChatBotError::Api {
            message: "session expired".to_string(),
            http_status: 200,
            errcode: -14,
        };
        assert!(err.is_session_expired());
    }

    #[test]
    fn session_expired_false() {
        let err = WeChatBotError::Api {
            message: "other error".to_string(),
            http_status: 400,
            errcode: -1,
        };
        assert!(!err.is_session_expired());
    }

    #[test]
    fn non_api_not_session_expired() {
        let err = WeChatBotError::Auth("test".to_string());
        assert!(!err.is_session_expired());
    }

    #[test]
    fn error_display() {
        let err = WeChatBotError::Api {
            message: "bad request".to_string(),
            http_status: 400,
            errcode: -1,
        };
        let msg = format!("{}", err);
        assert!(msg.contains("bad request"));
        assert!(msg.contains("400"));
        assert!(msg.contains("-1"));
    }

    #[test]
    fn no_context_error() {
        let err = WeChatBotError::NoContext("user123".to_string());
        let msg = format!("{}", err);
        assert!(msg.contains("user123"));
    }
}
