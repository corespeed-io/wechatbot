import { setTimeout as delay } from 'node:timers/promises';

export async function loginWithRetry(login, { stopped = () => false, notify = () => {}, wait = delay } = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (stopped()) return null;
    try { return await login(); }
    catch (error) {
      const transient = ['TimeoutError', 'AbortError', 'TransportError'].includes(error.name);
      if (stopped()) return null;
      if (!transient || attempt === 4) throw error;
      notify(attempt, error.name);
      await wait(Math.min(2000 * attempt, 6000));
    }
  }
}
