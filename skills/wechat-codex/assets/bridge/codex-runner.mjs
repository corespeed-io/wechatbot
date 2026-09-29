import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export class CodexRunner {
  constructor({ cwd, runtimeDir, executable = 'codex', timeoutMs = 10 * 60_000 }) {
    Object.assign(this, { cwd, runtimeDir, executable, timeoutMs });
    this.threadId = null;
    this.child = null;
    this.running = false;
  }
  cancel() {
    if (!this.child) return false;
    this.cancelled = true;
    this.terminate();
    return true;
  }
  terminate() {
    const child = this.child;
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    this.killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
    this.killTimer.unref();
  }
  reset() {
    if (this.running) throw new Error('请先取消当前任务。');
    this.threadId = null;
  }
  async run(prompt) {
    if (this.running) throw new Error('Codex 正在处理上一条消息，请稍后再发。');
    this.running = true;
    this.cancelled = false;
    let timedOut = false;
    let dir;
    try {
      await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
      dir = await mkdtemp(join(this.runtimeDir, 'run-'));
      const output = join(dir, 'reply.txt');
      const args = ['exec', '--ignore-user-config', '--skip-git-repo-check',
        '--sandbox', 'workspace-write', '-c', 'approval_policy="never"',
        '-C', this.cwd];
      if (this.threadId) args.push('resume', this.threadId);
      args.push('--json', '-o', output, '-');
      const child = spawn(this.executable, args, { cwd: this.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.setEncoding('utf8');
      const timer = setTimeout(() => { timedOut = true; this.terminate(); }, this.timeoutMs);
      let buffer = '';
      let lastError = '';
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'thread.started') this.threadId = event.thread_id;
            if (event.type === 'turn.failed') lastError = event.error?.message ?? 'Codex 执行失败';
          } catch {}
        }
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      const completed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve(code));
      });
      child.stdin.end(prompt);
      let code;
      try { code = await completed; } finally { clearTimeout(timer); }
      if (this.cancelled) throw new Error('任务已取消。');
      if (timedOut) throw new Error('任务超过执行时限，已停止；可以拆分任务后重试。');
      if (code !== 0) throw new Error(lastError || 'Codex 执行失败，请在电脑上检查登录状态或额度。');
      const reply = (await readFile(output, 'utf8')).trim();
      if (!reply) throw new Error('Codex 没有返回文本。');
      return reply;
    } finally {
      clearTimeout(this.killTimer);
      this.child = null;
      this.running = false;
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }
}
