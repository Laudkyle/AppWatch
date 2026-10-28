import { Router } from 'express';
import { parseAppInput } from './validation.js';

export function createApiRouter(store, monitor) {
  const router = Router();
  router.get('/health', (_req, res) => res.json({ ok: true, ...monitor.state, appCount: store.list().length }));
  router.get('/apps', (req, res) => {
    const items = store.list();
    const group = typeof req.query.group === 'string' ? req.query.group.toLowerCase() : '';
    const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : '';
    res.json(items.filter(item => (!group || item.group.toLowerCase() === group) && (!search || `${item.name} ${item.url} ${item.group}`.toLowerCase().includes(search))));
  });
  router.post('/apps', async (req, res) => {
    try { const item = await store.create(parseAppInput(req.body)); res.status(201).json(item); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.get('/apps/:id', (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Application not found.' });
    res.json(item);
  });
  router.get('/apps/:id/history', (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Application not found.' });
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 24));
    res.json({ id: item.id, history: (item.history || []).slice(-limit) });
  });
  router.put('/apps/:id', async (req, res) => {
    try {
      const fields = parseAppInput(req.body, { partial: true });
      const item = await store.update(req.params.id, fields);
      if (!item) return res.status(404).json({ error: 'Application not found.' });
      res.json(item);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.delete('/apps/:id', async (req, res) => {
    if (!await store.remove(req.params.id)) return res.status(404).json({ error: 'Application not found.' });
    res.status(204).end();
  });
  router.post('/apps/:id/check', async (req, res) => {
    const result = await monitor.checkOne(req.params.id);
    if (!result) return res.status(404).json({ error: 'Application not found.' });
    res.json(result);
  });
  router.post('/check', async (_req, res) => {
    const result = await monitor.checkAll();
    res.json({ ...result, checking: monitor.state.checking });
  });
  router.use((_req, res) => res.status(404).json({ error: 'API route not found.' }));
  router.use((error, _req, res, _next) => {
    console.error('API request failed:', error);
    res.status(500).json({ error: 'Internal server error.' });
  });
  return router;
}
