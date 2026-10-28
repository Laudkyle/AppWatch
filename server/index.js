import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storePath = path.join(__dirname, 'apps.json');
const app = express();
const port = Number(process.env.PORT || 3001);
app.use(cors()); app.use(express.json());
let apps = [];
let checking = false;

async function persist() { await fs.writeFile(storePath, JSON.stringify(apps, null, 2)); }
async function load() {
  try { apps = JSON.parse(await fs.readFile(storePath, 'utf8')); }
  catch { apps = [
    { id: 'api-core', name: 'Core API', url: 'https://api.github.com', group: 'Production', x: 20, y: 31 },
    { id: 'web-app', name: 'Web application', url: 'https://example.com', group: 'Production', x: 50, y: 19 },
    { id: 'docs-site', name: 'Documentation', url: 'https://www.wikipedia.org', group: 'Services', x: 78, y: 34 },
    { id: 'staging', name: 'Staging environment', url: 'https://staging.example.com', group: 'Staging', x: 34, y: 72 },
    { id: 'media-cdn', name: 'Media CDN', url: 'https://cdn.jsdelivr.net', group: 'Services', x: 72, y: 76 }
  ].map(a => ({ ...a, status: 'unknown', latency: null, checkedAt: null, error: null, history: [] })); await persist(); }
}
function safeUrl(value) {
  const raw = String(value || '').trim();
  const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Enter a valid HTTP or HTTPS URL or IP address.');
  return parsed.toString().replace(/\/$/, '');
}
async function checkTarget(target) {
  const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // A HEAD probe avoids downloading an application's response body.
    let response = await fetch(target.url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    if (response.status === 405 || response.status === 501) response = await fetch(target.url, { method: 'GET', signal: controller.signal, redirect: 'follow', headers: { Range: 'bytes=0-0' } });
    const latency = Date.now() - started;
    const ok = response.status < 500;
    target.status = ok ? 'up' : 'down'; target.latency = latency; target.error = ok ? null : `HTTP ${response.status}`;
  } catch (error) {
    target.status = 'down'; target.latency = Date.now() - started; target.error = error.name === 'AbortError' ? 'Request timed out' : (error.cause?.code || error.message || 'Connection failed');
  } finally {
    clearTimeout(timer); target.checkedAt = new Date().toISOString();
    target.history = [...(target.history || []).slice(-23), { status: target.status, latency: target.latency, time: target.checkedAt }];
  }
}
async function checkAll() {
  if (checking || !apps.length) return;
  checking = true;
  try { await Promise.all(apps.map(checkTarget)); await persist(); }
  finally { checking = false; }
}
app.get('/api/apps', (_req, res) => res.json(apps));
app.post('/api/apps', async (req, res) => {
  try {
    const { name, url, group = 'Unassigned' } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Application name is required.' });
    const normalized = safeUrl(url);
    const item = { id: randomUUID(), name: String(name).trim(), url: normalized, group: String(group).trim() || 'Unassigned', x: 20 + Math.random() * 60, y: 20 + Math.random() * 60, status: 'unknown', latency: null, checkedAt: null, error: null, history: [] };
    apps.push(item); await persist(); checkTarget(item).then(persist); res.status(201).json(item);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.put('/api/apps/:id', async (req, res) => {
  const item = apps.find(a => a.id === req.params.id); if (!item) return res.status(404).json({ error: 'Application not found.' });
  try { const { name, url, group, x, y } = req.body || {}; if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'Application name is required.' });
    if (name !== undefined) item.name = String(name).trim(); if (url !== undefined) item.url = safeUrl(url); if (group !== undefined) item.group = String(group).trim() || 'Unassigned';
    if (Number.isFinite(x)) item.x = Math.min(90, Math.max(8, x)); if (Number.isFinite(y)) item.y = Math.min(88, Math.max(10, y));
    await persist(); res.json(item);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/apps/:id', async (req, res) => { const before = apps.length; apps = apps.filter(a => a.id !== req.params.id); if (apps.length === before) return res.status(404).json({ error: 'Application not found.' }); await persist(); res.status(204).end(); });
app.post('/api/check', async (_req, res) => { await checkAll(); res.json({ checkedAt: new Date().toISOString(), apps }); });
app.get('/api/health', (_req, res) => res.json({ ok: true, intervalSeconds: 60, checking }));
const clientDist = path.resolve(__dirname, '../dist');
app.use(express.static(clientDist));
app.get('*path', (_req, res, next) => res.sendFile(path.join(clientDist, 'index.html'), error => error && next()));
await load();
app.listen(port, () => console.log(`AppWatch API listening on http://localhost:${port}`));
checkAll(); setInterval(checkAll, 60_000);
