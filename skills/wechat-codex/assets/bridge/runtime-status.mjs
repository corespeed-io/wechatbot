import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function createStatus(dir, snapshot = () => ({})) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'bridge.lock');
  const path = join(dir, 'status.json');
  function acquire() {
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  try { acquire(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid bridge lock; inspect before restarting.');
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
    if (alive) throw new Error('A bridge process is already using this directory.');
    unlinkSync(lock);
    acquire();
  }
  let state = 'starting';
  let lastError = null;
  function update(next = state, error = lastError) {
    state = next; lastError = error;
    const value = { pid: process.pid, state, lastError, ...snapshot(), updatedAt: new Date().toISOString() };
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temp, path);
  }
  update();
  const heartbeat = setInterval(() => update(), 15_000);
  heartbeat.unref();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { update(state === 'failed' ? 'failed' : 'stopped'); } catch {}
    try { if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock); } catch {}
  }
  process.once('exit', close);
  return { update, close };
}
