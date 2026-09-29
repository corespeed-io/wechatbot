import { WeChatBot } from '@wechatbot/wechatbot';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { CodexRunner } from './codex-runner.mjs';
import { loginWithRetry } from './login-retry.mjs';
import { resolve } from 'node:path';
import { createStatus } from './runtime-status.mjs';
import { acceptMessage } from './message-gate.mjs';

const cwd = process.env.WECHAT_CODEX_WORKDIR ? resolve(process.env.WECHAT_CODEX_WORKDIR) : fileURLToPath(new URL('./codex-workspace/', import.meta.url));
const runtimeDir = fileURLToPath(new URL('./.runtime/', import.meta.url));
await mkdir(cwd, { recursive: true });
const runner = new CodexRunner({ cwd, runtimeDir, executable: process.env.WECHAT_CODEX_BIN || 'codex' });
const bot = new WeChatBot({ storage: 'memory', logLevel: 'silent' });
const seen = new Set();
let owner;
let busy = false;
let stopping = false;
let handled = 0;
const status = createStatus(runtimeDir, () => ({ cwd, threadId: runner.threadId, busy, successfulReplies: handled }));
const help = '已接入本机 Codex。直接发送任务即可，例如：写一个 Python 猜数字游戏并测试。\n\n/status：状态\n/new：新对话\n/cancel：取消当前任务\n/stop：停止连接\n/help：帮助\n\n当前支持文字，文件修改使用专用 codex-workspace 目录。';

async function shutdown() {
  if (stopping) return;
  stopping = true;
  status.update('stopping');
  runner.cancel();
  bot.stop();
  console.log('STOPPED');
  setTimeout(() => process.exit(0), 4000).unref();
}

bot.on('error', error => { status.update('degraded', error.name); console.error('WECHAT_ERROR', error.name); });
bot.on('poll:start', () => { status.update('online', null); console.log('ONLINE：微信已连接 Codex，等待文字任务。'); });
bot.onMessage(async msg => {
  if (stopping || !acceptMessage(msg, owner, seen)) return;
  if (msg.type !== 'text') {
    await bot.reply(msg, '当前版本支持文字任务，请用文字发送。').catch(() => {});
    return;
  }
  const text = (msg.text ?? '').trim();
  try {
    if (text === '/help' || text === '帮助') return await bot.reply(msg, help);
    if (text === '/status') return await bot.reply(msg, `Codex ${busy ? '正在执行任务' : '空闲'}；已完成 ${handled} 次任务。\n工作目录：${cwd}\n会话：${runner.threadId || '尚未开始'}`);
    if (text === '/cancel') return await bot.reply(msg, runner.cancel() ? '正在取消当前任务。' : '当前没有运行中的任务。');
    if (text === '/stop') { await bot.reply(msg, '已停止微信 Codex 连接。'); return await shutdown(); }
    if (text === '/new') {
      if (busy) return await bot.reply(msg, '请先 /cancel 取消当前任务，再开始新对话。');
      runner.reset(); status.update('online', null); return await bot.reply(msg, '已开始新对话，工作目录中的文件保留。');
    }
    if (!text) return await bot.reply(msg, '当前支持文字任务。请发送文字，或 /help 查看说明。');
    if (text.length > 16000) return await bot.reply(msg, '这条消息太长，请拆成几段任务发送。');
    if (busy) return await bot.reply(msg, 'Codex 正在执行上一条任务；完成后再发，或 /cancel 取消。');
    busy = true;
    status.update('busy', null);
    let typing;
    try {
      await bot.reply(msg, '收到，Codex 开始处理。');
      await bot.sendTyping(msg.userId).catch(() => {});
      typing = setInterval(() => void bot.sendTyping(msg.userId).catch(() => {}), 8000);
      const answer = await runner.run(text);
      await bot.reply(msg, answer);
      handled++;
      status.update('online', null);
      console.log(`SESSION_ID ${runner.threadId}`);
      console.log(`REPLY_OK count=${handled}`);
    } catch (error) {
      status.update('task_failed', error.name);
      if (!stopping) await bot.reply(msg, `任务未完成：${error.message}`);
      console.error('TASK_FAILED');
    } finally {
      clearInterval(typing);
      await bot.stopTyping(msg.userId).catch(() => {});
      busy = false;
      status.update();
    }
  } catch { status.update('degraded', 'ReplyError'); console.error('WECHAT_REPLY_FAILED'); }
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
const credentials = await loginWithRetry(() => bot.login({ callbacks: {
  onQrUrl: url => {
    void QRCode.toFile(fileURLToPath(new URL('./codex-login-qr.png', import.meta.url)), url, { width: 420, margin: 4 })
      .then(() => { status.update('awaiting_scan', null); console.log('QR_READY：codex-login-qr.png'); })
      .catch(() => { console.error('QR_FAILED'); process.exit(1); });
  },
  onScanned: () => { status.update('awaiting_confirmation', null); console.log('SCANNED：请在微信确认。'); },
  onExpired: () => { status.update('qr_expired'); console.log('QR_EXPIRED：正在刷新。'); },
}}), {
  stopped: () => stopping,
  notify: (attempt, reason) => { status.update('login_retry', reason); console.log(`LOGIN_RETRY ${attempt}/3 reason=${reason}：网络请求失败，正在重新获取二维码。`); },
}).catch(error => {
  status.update('failed', error.name);
  console.error(`LOGIN_FAILED reason=${error.name}：本轮登录未完成，请重新启动。`);
  process.exitCode = 1;
  return null;
});
if (!credentials) process.exit(process.exitCode ?? 0);
owner = credentials.userId;
console.log('LOGIN_OK');
await bot.start();
