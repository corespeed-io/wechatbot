use wechatbot::{BotOptions, WeChatBot};

#[test]
fn typing_status_api_is_public_and_backwards_compatible() {
    let bot = WeChatBot::new(BotOptions::default());

    // Existing API remains available.
    drop(bot.send_typing("user-id"));

    // New API allows callers to choose the protocol status.
    drop(bot.send_typing_with_status("user-id", 2));
}
