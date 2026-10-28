import nodemailer from 'nodemailer';

export class AlertService {
  #store;
  #transport;
  #from;

  constructor(store) {
    this.#store = store;
    this.#from = process.env.SMTP_FROM || process.env.SMTP_USER;
    const host = process.env.SMTP_HOST;
    if (host && this.#from) {
      this.#transport = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined
      });
    }
  }

  get configured() { return Boolean(this.#transport && this.#from); }

  async sendVerification(user, token) {
    if (!this.configured) throw new Error('Email delivery is not configured.');
    const link = accountLink('verify', token);
    await this.#transport.sendMail({
      from: this.#from,
      to: user.email,
      subject: 'Verify your AppWatch email',
      text: `Hello ${user.name},\n\nVerify your email address to activate your AppWatch account:\n${link}\n\nThis link expires in 24 hours. If you did not create this account, you can ignore this message.`,
      html: `<p>Hello ${escapeHtml(user.name)},</p><p>Verify your email address to activate your AppWatch account:</p><p><a href="${escapeHtml(link)}">Verify email</a></p><p>This link expires in 24 hours. If you did not create this account, you can ignore this message.</p>`
    });
  }

  async sendPasswordReset(user, token) {
    if (!this.configured) throw new Error('Email delivery is not configured.');
    const link = accountLink('reset', token);
    await this.#transport.sendMail({
      from: this.#from,
      to: user.email,
      subject: 'Reset your AppWatch password',
      text: `Hello ${user.name},\n\nUse this link to reset your AppWatch password:\n${link}\n\nThis link expires in 1 hour. If you did not request a reset, you can ignore this message.`,
      html: `<p>Hello ${escapeHtml(user.name)},</p><p>Use this link to reset your AppWatch password:</p><p><a href="${escapeHtml(link)}">Reset password</a></p><p>This link expires in 1 hour. If you did not request a reset, you can ignore this message.</p>`
    });
  }

  async test(userId) {
    if (!this.configured) throw new Error('Email delivery is not configured. Set SMTP_HOST and SMTP_FROM in .env, then restart AppWatch.');
    const preferences = await this.#store.getPreferences(userId);
    if (!preferences) throw new Error('Account not found.');
    await this.#transport.sendMail({
      from: this.#from,
      to: preferences.notifications.alertEmail,
      subject: 'AppWatch test notification',
      text: `Hello ${preferences.profile.name},\n\nThis is a test notification from AppWatch. Email delivery is working.\n\nAppWatch`,
      html: `<p>Hello ${escapeHtml(preferences.profile.name)},</p><p>This is a test notification from AppWatch. Email delivery is working.</p><p>AppWatch</p>`
    });
  }

  async notify({ userId, app, previousStatus }) {
    if (!this.configured) return;
    const recovered = app.status === 'up' && previousStatus === 'down';
    const wentDown = app.status === 'down' && previousStatus !== 'down';
    if (!recovered && !wentDown) return;
    const preferences = await this.#store.getPreferences(userId);
    if (!preferences?.notifications.emailAlerts) return;
    if (recovered && !preferences.notifications.alertOnRecovery) return;
    if (wentDown && !preferences.notifications.alertOnDown) return;
    const label = recovered ? 'Recovered' : 'Down';
    const url = escapeHtml(app.url);
    const detail = recovered ? `The endpoint responded in ${app.latency} ms.` : `The endpoint is unreachable${app.error ? `: ${app.error}` : '.'}`;
    await this.#transport.sendMail({
      from: this.#from,
      to: preferences.notifications.alertEmail,
      subject: `AppWatch: ${app.name} is ${label.toLowerCase()}`,
      text: `${app.name} is ${label.toLowerCase()}\n${app.url}\n${detail}\nChecked at ${app.checkedAt}.`,
      html: `<h2>${escapeHtml(app.name)} is ${label.toLowerCase()}</h2><p><a href="${url}">${url}</a></p><p>${escapeHtml(detail)}</p><p>Checked at ${escapeHtml(app.checkedAt)}.</p>`
    });
  }
}

function accountLink(key, token) {
  const link = new URL(process.env.APP_BASE_URL || 'http://localhost:5173');
  link.searchParams.set(key, token);
  return link.toString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
