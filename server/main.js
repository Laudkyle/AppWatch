import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, migrate } from './db.js';
import { PgStore } from './pg-store.js';
import { Monitor } from './monitor.js';
import { AlertService } from './alerts.js';
import { createApiRouter } from './api.js';
import { createAuthRouter, requireAuth } from './auth.js';
import { validateTargetSecurityConfig } from './target-security.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3001);
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) throw new Error('Set SESSION_SECRET to a random value of at least 32 characters.');
validateTargetSecurityConfig();
await migrate();
const store = new PgStore(pool);
const alerts = new AlertService(store);
const monitor = new Monitor(store, alerts);
const app = express();

app.disable('x-powered-by');
if (process.env.COOKIE_SECURE === 'true') app.set('trust proxy', 1);
const allowedOrigin = process.env.CORS_ORIGIN;
app.use(cors({ origin: allowedOrigin || false, credentials: true }));
app.use(express.json({ limit: '32kb' }));
const PgSessionStore = connectPgSimple(session);
app.use(session({
  name: 'appwatch.sid',
  store: new PgSessionStore({ pool, createTableIfMissing: true, tableName: 'sessions' }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use('/api/auth', createAuthRouter(store, alerts));
app.get('/api/health', async (_req, res, next) => {
  try { const { rows } = await pool.query('SELECT count(*)::int AS count FROM apps'); res.json({ ok: true, ...monitor.state, appCount: rows[0].count }); }
  catch (error) { next(error); }
});
app.use('/api', requireAuth, (req, _res, next) => { req.userId = req.session.userId; next(); }, createApiRouter(store, monitor, alerts));

const clientDist = path.resolve(dirname, '../dist');
app.use(express.static(clientDist));
app.get('*path', (_req, res, next) => res.sendFile(path.join(clientDist, 'index.html'), error => error && next()));
app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Request body must contain valid JSON.' });
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error.' });
});

const server = app.listen(port, () => {
  console.log(`AppWatch backend listening on http://localhost:${port}`);
});
async function shutdown() {
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
