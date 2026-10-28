import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppStore } from './store.js';
import { Monitor } from './monitor.js';
import { createApiRouter } from './routes.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3001);
const store = await new AppStore(process.env.APPWATCH_DATA_FILE || path.join(dirname, 'apps.json')).open();
const monitor = new Monitor(store);
const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '32kb' }));
app.use('/api', createApiRouter(store, monitor));

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
  monitor.start();
});
function shutdown() {
  monitor.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
