const MAX_CONCURRENT_CHECKS = Math.max(1, Number(process.env.CHECK_CONCURRENCY || 8));

async function probe(url, timeoutSeconds) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    let response = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow', headers: { Range: 'bytes=0-0' } });
      if (response.body) await response.body.cancel();
    }
    return { status: response.status < 500 ? 'up' : 'down', latency: Date.now() - started, error: response.status < 500 ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { status: 'down', latency: Date.now() - started, error: error.name === 'AbortError' ? 'Request timed out' : (error.cause?.code || error.message || 'Connection failed') };
  } finally { clearTimeout(timeout); }
}

export class Monitor {
  #store;
  #alerts;
  #timer = null;
  #running = false;
  #lastRun = null;
  #lastUserRuns = new Map();
  #schedulerBusy = false;

  constructor(store, alerts) { this.#store = store; this.#alerts = alerts; }
  get state() { return { checking: this.#running, lastCheckAt: this.#lastRun }; }

  async checkOne(id) {
    const app = await this.#store.getForCheck(id);
    if (!app) return null;
    const result = await probe(app.url, Number(app.timeoutSeconds) || Number(process.env.CHECK_TIMEOUT_MS || 8000) / 1000);
    const checkedAt = new Date().toISOString();
    const update = await this.#store.updateCheck(id, result, checkedAt);
    if (!update) return null;
    if (this.#alerts) this.#alerts.notify({ userId: update.userId, app: update.app, previousStatus: update.previousStatus }).catch(error => console.error('AppWatch alert delivery failed:', error));
    return update.app;
  }

  async checkAll() {
    return this.checkSelected(await this.#store.listAllIds());
  }

  async checkSelected(ids) {
    if (this.#running) return { started: false, checkedAt: this.#lastRun };
    this.#running = true;
    const checkedAt = new Date().toISOString();
    this.#lastRun = checkedAt;
    try {
      const checked = [];
      for (let i = 0; i < ids.length; i += MAX_CONCURRENT_CHECKS) {
        checked.push(...await Promise.all(ids.slice(i, i + MAX_CONCURRENT_CHECKS).map(id => this.checkOne(id))));
      }
      return { started: true, checkedAt, apps: checked.filter(Boolean) };
    } finally { this.#running = false; }
  }

  start() {
    if (this.#timer) return;
    this.#runDueSchedules().catch(error => console.error('Initial health check failed:', error));
    this.#timer = setInterval(() => this.#runDueSchedules().catch(error => console.error('Scheduled health check failed:', error)), 5_000);
    this.#timer.unref?.();
  }

  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  async #runDueSchedules() {
    if (this.#schedulerBusy) return;
    this.#schedulerBusy = true;
    try {
      const now = Date.now();
      for (const schedule of await this.#store.listSchedules()) {
        const intervalMs = Number(schedule.checkIntervalSeconds) * 1000;
        if (now - (this.#lastUserRuns.get(schedule.userId) || 0) < intervalMs) continue;
        const result = await this.checkSelected(schedule.ids);
        if (result.started) this.#lastUserRuns.set(schedule.userId, Date.now());
      }
    } finally { this.#schedulerBusy = false; }
  }
}
