import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { parseAppInput } from './validation.js';
import { validateTargetBeforeSave } from './target-security.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isBool = value => typeof value === 'boolean';
const colorPattern = /^#[0-9a-fA-F]{6}$/;

export function createApiRouter(store, monitor, alerts) {
  const router = Router();
  router.param('id', (req, res, next, id) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return res.status(404).json({ error: 'Application not found.' });
    next();
  });
  router.get('/apps', async (req, res) => {
    const { search = '', group = '' } = req.query;
    res.json(await store.list(req.userId, {
      search: typeof search === 'string' ? search.slice(0, 100) : '',
      group: typeof group === 'string' ? group.slice(0, 40) : ''
    }));
  });
  router.get('/settings', async (req, res) => {
    const [preferences, groups] = await Promise.all([store.getPreferences(req.userId), store.listGroups(req.userId)]);
    if (!preferences) return res.status(404).json({ error: 'Account not found.' });
    res.json({ ...preferences, groups, emailDeliveryConfigured: alerts.configured });
  });
  router.put('/settings/profile', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!name || name.length > 80) return res.status(400).json({ error: 'Name is required and must be 80 characters or fewer.' });
    if (email.length > 254 || !emailPattern.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    try { res.json({ profile: await store.updateProfile(req.userId, { name, email }) }); }
    catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'That email is already in use.' }); throw error; }
  });
  router.put('/settings/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || newPassword.length < 8 || Buffer.byteLength(newPassword, 'utf8') > 72) return res.status(400).json({ error: 'Enter your current password and a new password of at least 8 characters (72 bytes maximum).' });
    const user = await store.getUserForPassword(req.userId);
    if (!user || !await bcrypt.compare(currentPassword, user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect.' });
    await store.updatePassword(req.userId, await bcrypt.hash(newPassword, 12), req.sessionID);
    res.json({ ok: true });
  });
  router.put('/settings/monitoring', async (req, res) => {
    const { checkIntervalSeconds, timeoutSeconds } = req.body || {};
    if (!Number.isInteger(checkIntervalSeconds) || checkIntervalSeconds < 30 || checkIntervalSeconds > 3600) return res.status(400).json({ error: 'Check interval must be between 30 and 3600 seconds.' });
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 2 || timeoutSeconds > 60) return res.status(400).json({ error: 'Timeout must be between 2 and 60 seconds.' });
    res.json(await store.updateMonitoring(req.userId, { checkIntervalSeconds, timeoutSeconds }));
  });
  router.put('/settings/notifications', async (req, res) => {
    const { emailAlerts, alertEmail, alertOnDown, alertOnRecovery } = req.body || {};
    const email = typeof alertEmail === 'string' ? alertEmail.trim().toLowerCase() : '';
    if (![emailAlerts, alertOnDown, alertOnRecovery].every(isBool)) return res.status(400).json({ error: 'Notification switches must be true or false.' });
    if (email.length > 254 || !emailPattern.test(email)) return res.status(400).json({ error: 'Enter a valid alert email address.' });
    const preferences = await store.getPreferences(req.userId);
    const storedAlertEmail = email === preferences.profile.email.toLowerCase() ? null : email;
    res.json(await store.updateNotifications(req.userId, { emailAlerts, alertEmail: storedAlertEmail, alertOnDown, alertOnRecovery }));
  });
  router.post('/settings/test-alert', async (req, res) => {
    try { await alerts.test(req.userId); res.json({ ok: true }); }
    catch (error) { res.status(alerts.configured ? 502 : 503).json({ error: error.message || 'Could not send test email.' }); }
  });
  router.get('/groups', async (req, res) => res.json(await store.listGroups(req.userId)));
  router.post('/groups', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const color = typeof req.body?.color === 'string' ? req.body.color : '#6d8df4';
    if (!name || name.length > 40) return res.status(400).json({ error: 'Group name is required and must be 40 characters or fewer.' });
    if (!colorPattern.test(color)) return res.status(400).json({ error: 'Choose a valid group color.' });
    try { res.status(201).json(await store.createGroup(req.userId, { name, color })); }
    catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'A group with that name already exists.' }); throw error; }
  });
  router.put('/groups/:id', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const color = typeof req.body?.color === 'string' ? req.body.color : '';
    if (!name || name.length > 40) return res.status(400).json({ error: 'Group name is required and must be 40 characters or fewer.' });
    if (!colorPattern.test(color)) return res.status(400).json({ error: 'Choose a valid group color.' });
    try {
      const group = await store.updateGroup(req.userId, req.params.id, { name, color });
      if (!group) return res.status(404).json({ error: 'Group not found.' });
      res.json(group);
    } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'A group with that name already exists.' }); if (error.code === 'GROUP_RESERVED') return res.status(400).json({ error: error.message }); throw error; }
  });
  router.delete('/groups/:id', async (req, res) => {
    const group = (await store.listGroups(req.userId)).find(item => item.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    if (group.name === 'Unassigned') return res.status(409).json({ error: 'The Unassigned group is required and cannot be removed.' });
    if (!await store.removeGroup(req.userId, req.params.id)) return res.status(409).json({ error: 'This group could not be removed.' });
    res.status(204).end();
  });
  router.post('/apps', async (req, res) => {
    try {
      const fields = parseAppInput(req.body);
      await validateTargetBeforeSave(fields.url);
      const item = await store.create(req.userId, fields);
      res.status(201).json(item);
      monitor.checkOne(item.id).catch(error => console.error('Initial app check failed:', error));
    }
    catch (error) { if (error.code === 'TARGET_NOT_ALLOWED') return res.status(400).json({ error: error.message }); if (error instanceof Error && !error.code) return res.status(400).json({ error: error.message }); if (error.code === '23503') return res.status(400).json({ error: 'Choose one of your existing groups.' }); throw error; }
  });
  router.get('/apps/:id', async (req, res) => {
    const item = await store.get(req.userId, req.params.id);
    if (!item) return res.status(404).json({ error: 'Application not found.' });
    res.json(item);
  });
  router.get('/apps/:id/history', async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 24));
    const result = await store.getHistory(req.userId, req.params.id, limit);
    if (!result) return res.status(404).json({ error: 'Application not found.' });
    res.json(result);
  });
  router.put('/apps/:id', async (req, res) => {
    let fields;
    try { fields = parseAppInput(req.body, { partial: true }); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    let item;
    try { if (fields.url) await validateTargetBeforeSave(fields.url); item = await store.update(req.userId, req.params.id, fields); }
    catch (error) { if (error.code === 'TARGET_NOT_ALLOWED') return res.status(400).json({ error: error.message }); if (error.code === '23503') return res.status(400).json({ error: 'Choose one of your existing groups.' }); throw error; }
    if (!item) return res.status(404).json({ error: 'Application not found.' });
    res.json(item);
  });
  router.delete('/apps/:id', async (req, res) => {
    if (!await store.remove(req.userId, req.params.id)) return res.status(404).json({ error: 'Application not found.' });
    res.status(204).end();
  });
  router.post('/apps/:id/check', async (req, res) => {
    const owned = await store.get(req.userId, req.params.id);
    if (!owned) return res.status(404).json({ error: 'Application not found.' });
    const result = await monitor.checkOne(req.params.id);
    if (!result) return res.status(404).json({ error: 'Application not found.' });
    res.json(result);
  });
  router.post('/check', async (_req, res) => {
    const apps = await store.list(_req.userId);
    const result = await monitor.checkSelected(apps.map(item => item.id));
    res.json({ ...result, checking: monitor.state.checking });
  });
  router.use((_req, res) => res.status(404).json({ error: 'API route not found.' }));
  return router;
}
