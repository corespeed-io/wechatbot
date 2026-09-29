---
name: wechat-codex
description: Connect WeChat to a local Codex CLI session, display its login QR code, verify message delivery, locate or open the linked session, and troubleshoot or stop the bridge. Use for requests such as 把 Codex 接入微信 or 查看微信连接状态.
---

# WeChat ↔ Codex

Operate a local bridge backed by `@wechatbot/wechatbot` and the user's installed Codex CLI. A skill orchestrates setup and troubleshooting; a running Node process handles ongoing messages. Do not substitute Pi, Claude, or OpenClaw for a requested Codex connection.

## Start or reconnect

1. Look for the bridge already used in the current task. Read its status before installing or restarting anything. Keep a healthy existing connection running. One WeChat account should have one polling instance; don't restart merely to apply a skill update.
2. Check `node --version` (22+), `codex --version`, `codex login status`, and relevant flags in `codex exec --help`. Reuse existing Codex authentication. If login is missing, let the user complete `codex login`; do not ask them to paste tokens into chat. The bundled cancellation implementation targets macOS/Linux; do not claim Windows support without adapting and testing process handling.
3. Use the user's chosen project as the Codex working directory. If none is chosen, use the bridge's dedicated `codex-workspace` directory and say so. This starts an independent CLI session, not the current App conversation. Only attach an existing session when the user identifies it, and first ensure it has no other writer.
4. Scaffold into a task-owned directory, preferably an `outputs/` directory for a deliverable:

   ```sh
   python3 <skill-dir>/scripts/setup.py --target <absolute-bridge-dir>
   npm --prefix <absolute-bridge-dir> ci --ignore-scripts --no-audit --no-fund
   ```

   `setup.py` refuses to overwrite existing files. Dependencies and bridge code belong in the target, never run from or install dependencies into the skill directory.
5. Launch with a long-lived PTY so a WeChat pairing-code prompt can be completed if needed. Keep the host awake and retain the process handle; this skill does not install a system service:

   ```sh
   node <absolute-bridge-dir>/codex-wechat.mjs
   ```

   Optional `WECHAT_CODEX_WORKDIR` selects the task workspace; `WECHAT_CODEX_BIN` selects an explicitly located Codex binary. Verify `QR_READY`, then display `<bridge-dir>/codex-login-qr.png` as a local image. The user scans and confirms. Never claim success just because a QR exists. Login timeouts retry at most three times; terminal failures need diagnosis rather than an unbounded restart loop.
6. Verify `LOGIN_OK` / `ONLINE`. Ask the user to send one short task, then check `REPLY_OK` or the status file's successful reply count. A Codex-only smoke test is not a WeChat round-trip test. Report exactly which stages passed.

## Status and finding the session

```sh
python3 <skill-dir>/scripts/status.py --target <absolute-bridge-dir>
```

The helper reads only bridge metadata. `processAlive` means only that a PID exists; `fresh` checks the heartbeat. Even fresh `online` status describes the last reported state, not a new network probe. Report the last failure when present.

The first task creates a Codex session; the runner resumes only that exact ID afterward. `/status` displays the ID. `/new` resets it for the next task. The bundled bridge starts a new conversation after process restart; don't promise cross-restart conversation recovery.

To view a session:

- In Codex App, use `read_thread` with the exact ID, then `navigate_to_codex_page` when the user wants it opened. A CLI-created session can be readable even when absent from the sidebar list. Do not declare it invisible merely because `list_threads` omits it.
- In a terminal, use `codex resume <SESSION_ID>`. The picker may need `--all --include-non-interactive` on versions supporting those flags. Avoid simultaneous App/terminal and WeChat writes to the same session.
- For an older bridge without status metadata, search only the first `session_meta` line of local session files, restricted to the exact bridge working directory and relevant dates. Treat the newest match as a candidate until verified; do not read or export unrelated session histories.

## Commands and boundaries

Text tasks are sent to Codex and replies return to the authenticated WeChat sender. Commands: `/help`, `/status`, `/new`, `/cancel`, `/stop`. Busy requests are rejected rather than silently queued. The runtime deduplicates message IDs, bounds task duration, and restricts messages to the account that scanned in.

The default uses `workspace-write` and no interactive approvals. Explain failed operations; don't bypass the sandbox. `--ignore-user-config` avoids automatically importing unrelated MCP configuration while retaining CLI authentication. This does not mean the entire machine is inaccessible or all global context is disabled.

WeChat credentials stay in process memory. Codex persists its own sessions normally. Runtime metadata contains the session ID and status, not tokens or message bodies. Keep generated QR codes, runtime files, account identifiers and private sessions out of shared skill bundles and PRs.

Stop via `/stop` or signal the verified bridge process. Do not kill processes using a broad `pkill node` or `pkill codex` pattern. If a bridge is healthy, status requests should be read-only.

## Troubleshooting learned from live use

- `QR_READY` followed by a login `TimeoutError`: QR-status polling failed, not proof of bad Codex authentication. Bounded login retries issue a fresh QR; show the latest one.
- `ONLINE` with no replies: check successful reply count, task errors, sender matching, and Codex auth separately. Don't print credential contents to diagnose.
- Session missing from sidebar: use its exact ID and read/open it directly before proposing a different architecture.
- If the user wants a public contribution, package this bridge and workflow as an example/skill. Local installation alone does not imply permission to publish a PR.

Sources: [WeChatBot SDK](https://www.wechatbot.dev/zh/nodejs), [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Tencent's OpenClaw Weixin plugin](https://github.com/Tencent/openclaw-weixin). The Tencent plugin is an alternative integration path, not a dependency of this bridge.

## Maintainer validation

From the repository root, run `node --test skills/wechat-codex/tests/*.test.mjs` and `python3 -m unittest discover -s skills/wechat-codex/tests -p 'test_*.py'`. Tests use temporary workspaces and fake Codex processes; they do not authenticate to WeChat or send messages. A real scan and reply remains a separate manual integration check.
