// Echo bot example — receives messages and replies with "Echo: <text>".
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	wechatbot "github.com/corespeed-io/wechatbot-go"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	bot := wechatbot.New(wechatbot.Options{
		OnQRURL: func(url string) {
			fmt.Printf("\nScan this URL in WeChat:\n%s\n\n", url)
		},
		OnError: func(err error) {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		},
	})

	creds, err := bot.Login(ctx, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Login failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Logged in: %s (%s)\n", creds.AccountID, creds.UserID)

	count := 0
	bot.OnMessage(func(msg *wechatbot.IncomingMessage) {
		count++
		fmt.Printf("[%d] %s: %s\n", count, msg.UserID, msg.Text)

		_ = bot.SendTyping(ctx, msg.UserID)

		if err := bot.Reply(ctx, msg, fmt.Sprintf("Echo: %s", msg.Text)); err != nil {
			fmt.Fprintf(os.Stderr, "Reply failed: %v\n", err)
		}
	})

	fmt.Println("Listening for messages (Ctrl+C to stop)")
	if err := bot.Run(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "Run error: %v\n", err)
	}
	fmt.Printf("Stopped. Processed %d messages.\n", count)
}
