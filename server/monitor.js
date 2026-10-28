import http from 'node:http';
import https from 'node:https';
import { resolveAllowedTarget } from './target-security.js';

const MAX_CONCURRENT_CHECKS = Math.max(1, Number(process.env.CHECK_CONCURRENCY || 8));

function requestOnce(url, method, signal) {
  return new Promise(async (resolve, reject) => {
    let agent;
    try {
      const addresses = await resolveAllowedTarget(url);
      if (signal.aborted) throw Object.assign(new Error('Request timed out'), { name: 'AbortError' });
      const pinnedLookup = (_hostname, options, callback) => {
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      };
      const secure = url.protocol === 'https:';
      const transport = secure ? https : http;
      agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        agent.destroy();
        if (error) reject(error); else resolve(result);
      };
      const request = transport.request(url, {
        method,
        signal,
        agent,
        lookup: pinnedLookup,
        headers: method === 'GET' ? { Range: 'bytes=0-0', 'User-Agent': 'AppWatch-Monitor/1.0' } : { 'User-Agent': 'AppWatch-Monitor/1.0' }
      }, response => {
        const result = { status: response.statusCode || 0, location: response.headers.location || null };
        response.destroy();
        finish(null, result);
      });
      request.on('error', error => finish(error));
      request.end();
    } catch (error) {
      agent?.destroy();
      reject(error);
    }
  });
}

async function requestFollowingRedirects(initialUrl, method, signal) {
  let url = initialUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await requestOnce(url, method, signal);
    if (![301,302,303,307,308].includes(response.status) || !response.location) return response;
    if (redirectCount === 5) throw new Error('Too many redirects.');
    url = new URL(response.location, url);
    if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Redirected to a non-HTTP target.'), { code: 'TARGET_NOT_ALLOWED' });
  }
}

async function probe(target, timeoutSeconds) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const url = new URL(target);
    let response = await requestFollowingRedirects(url, 'HEAD', controller.signal);
    if (response.status === 405 || response.status === 501) response = await requestFollowingRedirects(url, 'GET', controller.signal);
    return { status: response.status < 500 ? 'up' : 'down', latency: Date.now() - started, error: response.status < 500 ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { status: 'down', latency: Date.now() - started, error: error.name === 'AbortError' ? 'Request timed out' : error.code === 'TARGET_NOT_ALLOWED' ? error.message : (error.cause?.code || error.message || 'Connection failed') };
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
