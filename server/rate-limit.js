import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(String(value)).digest('hex');

export function authRateLimit(store, scope, { limit, windowSeconds, emailField = true }) {
  return async (req, res, next) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const ipResult = await store.consumeRateLimit(`${scope}:ip:${digest(ip)}`, limit, windowSeconds);
      if (!ipResult.allowed) {
        res.set('Retry-After', String(ipResult.retryAfter));
        return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
      }
      const email = emailField && typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (email) {
        const emailResult = await store.consumeRateLimit(`${scope}:email:${digest(email)}`, limit, windowSeconds);
        if (!emailResult.allowed) {
          res.set('Retry-After', String(emailResult.retryAfter));
          return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
        }
      }
      next();
    } catch (error) {
      console.error('Authentication rate-limit check failed:', error);
      res.status(503).json({ error: 'Authentication is temporarily unavailable. Please try again shortly.' });
    }
  };
}
