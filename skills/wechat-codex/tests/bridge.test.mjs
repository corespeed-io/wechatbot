import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexRunner } from '../assets/bridge/codex-runner.mjs';
import { acceptMessage } from '../assets/bridge/message-gate.mjs';
import { loginWithRetry } from '../assets/bridge/login-retry.mjs';
import { createStatus } from '../assets/bridge/runtime-status.mjs';

async function fixture(t, timeoutMs = 5000) {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-codex-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake codex.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
let prompt=''; for await(const chunk of process.stdin) prompt+=chunk;
const args=process.argv.slice(2);
if(prompt==='hang') { setInterval(()=>{},1000); }
else if(prompt==='fail') {
  console.log(JSON.stringify({type:'turn.failed',error:{message:'synthetic failure'}}));
  process.exitCode=1;
} else {
  if(args.includes('resume') && args[args.indexOf('resume')+1]!=='test-thread') process.exit(2);
  console.log(JSON.stringify({type:'thread.started',thread_id:'test-thread'}));
  if(prompt!=='empty') writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({prompt,args}));
  else writeFileSync(args[args.indexOf('-o')+1],'');
}
`);
  await chmod(executable, 0o700);
  return { dir, runner: new CodexRunner({ cwd: dir, runtimeDir: join(dir, 'runtime'), executable, timeoutMs }) };
}

test('passes prompts via stdin, resumes the exact session, and resets', async t => {
  const { dir, runner } = await fixture(t);
  const prompt = '你好\n$(touch NEVER_EXECUTE) `echo nope`';
  const first = JSON.parse(await runner.run(prompt));
  assert.equal(first.prompt, prompt);
  assert.equal(first.args.includes(prompt), false);
  assert.equal(existsSync(join(dir, 'NEVER_EXECUTE')), false);
  assert.equal(first.args[first.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(first.args.includes('--ignore-user-config'));
  assert.equal(runner.threadId, 'test-thread');
  const second = JSON.parse(await runner.run('follow-up'));
  assert.equal(second.args[second.args.indexOf('resume') + 1], 'test-thread');
  assert.equal(second.args.includes('--last'), false);
  runner.reset();
  assert.equal(runner.threadId, null);
  assert.equal(JSON.parse(await runner.run('fresh')).args.includes('resume'), false);
  assert.deepEqual(await readdir(join(dir, 'runtime')), []);
});

test('rejects simultaneous calls before spawn and cancels a running process', async t => {
  const { runner } = await fixture(t);
  const running = runner.run('hang');
  const rejected = assert.rejects(running, /已取消/);
  await assert.rejects(runner.run('second'), /上一条消息/);
  assert.throws(() => runner.reset(), /取消/);
  for (let i = 0; !runner.child && i < 200; i++) await delay(5);
  assert.equal(runner.cancel(), true);
  await rejected;
  assert.equal(runner.child, null);
  assert.equal(runner.running, false);
  assert.equal(runner.cancel(), false);
});

test('times out and releases the runner', async t => {
  const { runner } = await fixture(t, 150);
  await assert.rejects(runner.run('hang'), /执行时限/);
  assert.equal(runner.running, false);
});

test('propagates failures and empty replies, cleaning temporary output', async t => {
  const { dir, runner } = await fixture(t);
  await assert.rejects(runner.run('fail'), /synthetic failure/);
  await assert.rejects(runner.run('empty'), /没有返回文本/);
  runner.executable = join(dir, 'missing-binary');
  await assert.rejects(runner.run('hello'), { code: 'ENOENT' });
  assert.equal(runner.running, false);
  assert.deepEqual(await readdir(join(dir, 'runtime')), []);
});

test('accepts only the paired sender in DMs and bounds duplicate history', () => {
  const seen = new Set();
  const msg = { userId: 'owner', raw: { message_id: 0 } };
  assert.equal(acceptMessage(msg, undefined, seen), false);
  assert.equal(acceptMessage({ ...msg, userId: 'other' }, 'owner', seen), false);
  assert.equal(acceptMessage({ ...msg, raw: { group_id: 'group' } }, 'owner', seen), false);
  assert.equal(seen.size, 0);
  assert.equal(acceptMessage(msg, 'owner', seen), true);
  assert.equal(acceptMessage(msg, 'owner', seen), false);
  const noId = { userId: 'owner', raw: { client_id: '' } };
  assert.equal(acceptMessage(noId, 'owner', seen), true);
  assert.equal(acceptMessage(noId, 'owner', seen), true);
  for (let id = 1; id <= 1001; id++) acceptMessage({ ...msg, raw: { message_id: id } }, 'owner', seen);
  assert.equal(seen.size, 1000);
});

test('retries only transient login errors, with a finite limit', async () => {
  let calls = 0;
  const transient = () => Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  assert.equal(await loginWithRetry(async () => {
    if (++calls < 3) throw transient();
    return 'credentials';
  }, { wait: async () => {} }), 'credentials');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(loginWithRetry(async () => { calls++; throw transient(); }, { wait: async () => {} }), { name: 'TimeoutError' });
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(loginWithRetry(async () => { calls++; throw new Error('auth'); }), /auth/);
  assert.equal(calls, 1);
  assert.equal(await loginWithRetry(async () => assert.fail(), { stopped: () => true }), null);
});

test('locks the runtime and writes observable session status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-status-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const status = createStatus(dir, () => ({ threadId: 'test-thread', successfulReplies: 2 }));
  t.after(() => status.close());
  assert.throws(() => createStatus(dir), /already using/);
  status.update('online', null);
  const stored = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
  assert.equal(stored.threadId, 'test-thread');
  assert.equal(stored.successfulReplies, 2);
  status.update('failed', 'TimeoutError');
  status.close();
  assert.equal(existsSync(join(dir, 'bridge.lock')), false);
  assert.equal(JSON.parse(await readFile(join(dir, 'status.json'))).state, 'failed');
});
