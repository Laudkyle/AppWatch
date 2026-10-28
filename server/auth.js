import { Router } from 'express';
import bcrypt from 'bcryptjs';

const publicUser = user => ({ id: user.id, name: user.name, email: user.email });
const validEmail = value => typeof value === 'string' && value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export function createAuthRouter(store) {
  const router = Router();
  router.get('/me', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Authentication required.' });
    const user = await store.getUser(req.session.userId);
    if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: 'Authentication required.' }); }
    res.json({ user });
  });
  router.post('/signup', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (!name || name.length > 80) return res.status(400).json({ error: 'Name is required and must be 80 characters or fewer.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'Password must be at least 8 characters and no more than 72 bytes.' });
    try {
      const user = await store.createUser({ name, email, passwordHash: await bcrypt.hash(password, 12) });
      await establishSession(req, user.id);
      res.status(201).json({ user: publicUser(user) });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' });
      throw error;
    }
  });
  router.post('/login', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!validEmail(email) || !password) return res.status(400).json({ error: 'Enter your email and password.' });
    const user = await store.findUserByEmail(email);
    if (!user || !await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    await establishSession(req, user.id);
    res.json({ user: publicUser(user) });
  });
  router.post('/logout', async (req, res) => {
    await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    res.clearCookie('appwatch.sid');
    res.status(204).end();
  });
  return router;
}

function establishSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) return reject(error);
      req.session.userId = userId;
      req.session.save(saveError => saveError ? reject(saveError) : resolve());
    });
  });
}

export async function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Authentication required.' });
  next();
}
