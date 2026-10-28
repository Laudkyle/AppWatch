import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { authRateLimit } from './rate-limit.js';

const publicUser = user => ({ id: user.id, name: user.name, email: user.email });
const validEmail = value => typeof value === 'string' && value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const hashToken = token => createHash('sha256').update(token).digest('hex');
const genericPasswordMessage = 'If an account matches that email, a password-reset link will be sent.';
const genericVerifyMessage = 'If the account exists and still needs verification, a verification email will be sent.';

export function createAuthRouter(store, alerts) {
  const router = Router();
  router.get('/me', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Authentication required.' });
    const user = await store.getUser(req.session.userId);
    if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: 'Authentication required.' }); }
    res.json({ user });
  });
  router.post('/signup', authRateLimit(store, 'signup', { limit: 5, windowSeconds: 3600 }), async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (!name || name.length > 80) return res.status(400).json({ error: 'Name is required and must be 80 characters or fewer.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'Password must be at least 8 characters and no more than 72 bytes.' });
    if (!alerts.configured) return res.status(503).json({ error: 'Email delivery must be configured before creating accounts. Add SMTP settings to .env and restart AppWatch.' });
    try {
      const user = await store.createUser({ name, email, passwordHash: await bcrypt.hash(password, 12) });
      const token = await issueToken(store, user.id, 'verify_email', 24 * 60 * 60 * 1000);
      try {
        await alerts.sendVerification(user, token);
        res.status(201).json({ verificationSent: true, message: 'Account created. Check your email for a verification link before signing in.' });
      } catch (error) {
        console.error('Verification email could not be delivered:', error);
        res.status(201).json({ verificationSent: false, message: 'Account created, but the verification email could not be delivered. Fix SMTP settings, then request another verification email.' });
      }
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' });
      throw error;
    }
  });
  router.post('/login', authRateLimit(store, 'login', { limit: 10, windowSeconds: 900 }), async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!validEmail(email) || !password) return res.status(400).json({ error: 'Enter your email and password.' });
    const user = await store.findUserByEmail(email);
    if (!user || !await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    if (!user.emailVerifiedAt) return res.status(403).json({ code: 'EMAIL_UNVERIFIED', error: 'Verify your email address before signing in.' });
    await establishSession(req, user.id);
    res.json({ user: publicUser(user) });
  });
  router.post('/verify-email', async (req, res) => {
    if (typeof req.body?.token !== 'string' || req.body.token.length < 32 || req.body.token.length > 128) return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    const user = await store.consumeVerificationToken(hashToken(req.body.token));
    if (!user) return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    res.json({ ok: true, message: 'Email verified. You can now sign in.' });
  });
  router.post('/resend-verification', authRateLimit(store, 'resend-verification', { limit: 3, windowSeconds: 3600 }), async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (alerts.configured) {
      const user = await store.findUserByEmail(email);
      if (user && !user.emailVerifiedAt) {
        const token = await issueToken(store, user.id, 'verify_email', 24 * 60 * 60 * 1000);
        alerts.sendVerification(user, token).catch(error => console.error('Verification email could not be delivered:', error));
      }
    }
    res.json({ message: genericVerifyMessage });
  });
  router.post('/forgot-password', authRateLimit(store, 'password-reset', { limit: 3, windowSeconds: 3600 }), async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (alerts.configured) {
      const user = await store.findUserByEmail(email);
      if (user) {
        const token = await issueToken(store, user.id, 'password_reset', 60 * 60 * 1000);
        alerts.sendPasswordReset(user, token).catch(error => console.error('Password-reset email could not be delivered:', error));
      }
    }
    res.json({ message: genericPasswordMessage });
  });
  router.post('/reset-password', authRateLimit(store, 'password-reset-submit', { limit: 5, windowSeconds: 3600, emailField: false }), async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (typeof token !== 'string' || token.length < 32 || token.length > 128 || typeof newPassword !== 'string' || newPassword.length < 8 || Buffer.byteLength(newPassword, 'utf8') > 72) return res.status(400).json({ error: 'Enter a valid reset link and a password of at least 8 characters (72 bytes maximum).' });
    const used = await store.consumePasswordResetToken(hashToken(token), await bcrypt.hash(newPassword, 12));
    if (!used) return res.status(400).json({ error: 'This password-reset link is invalid or has expired.' });
    res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
  });
  router.post('/logout', async (req, res) => {
    await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    res.clearCookie('appwatch.sid');
    res.status(204).end();
  });
  return router;
}

async function issueToken(store, userId, purpose, ttlMs) {
  const token = randomBytes(32).toString('base64url');
  await store.createAuthToken(userId, purpose, hashToken(token), new Date(Date.now() + ttlMs));
  return token;
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
