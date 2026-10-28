import { randomUUID } from 'node:crypto';

const appFields = `id, name, url, group_name AS "group", x, y, status, latency, checked_at AS "checkedAt", error`;
const mapApp = row => row && ({ ...row, latency: row.latency === null ? null : Number(row.latency), x: Number(row.x), y: Number(row.y), history: row.history || [] });

export class PgStore {
  constructor(pool) { this.pool = pool; }

  async createUser({ name, email, passwordHash }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('INSERT INTO users (id, name, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, email, created_at AS "createdAt"', [randomUUID(), name, email, passwordHash]);
      const user = rows[0];
      await client.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
      await client.query("INSERT INTO app_groups (id,user_id,name,color) VALUES ($1,$2,'Production','#6d8df4'),($3,$2,'Unassigned','#8993a2')", [randomUUID(),user.id,randomUUID()]);
      await client.query('COMMIT');
      return user;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async findUserByEmail(email) {
    const { rows } = await this.pool.query('SELECT id, name, email, password_hash AS "passwordHash", email_verified_at AS "emailVerifiedAt" FROM users WHERE email=$1', [email]);
    return rows[0] || null;
  }
  async getUser(id) {
    const { rows } = await this.pool.query('SELECT id, name, email FROM users WHERE id=$1', [id]);
    return rows[0] || null;
  }
  async getUserForPassword(id) {
    const { rows } = await this.pool.query('SELECT id,name,email,password_hash AS "passwordHash" FROM users WHERE id=$1', [id]);
    return rows[0] || null;
  }
  async updateProfile(id, { name, email }) {
    const { rows } = await this.pool.query('UPDATE users SET name=$2,email=$3 WHERE id=$1 RETURNING id,name,email', [id,name,email]);
    return rows[0] || null;
  }
  async updatePassword(id, passwordHash, currentSessionId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('UPDATE users SET password_hash=$2 WHERE id=$1', [id,passwordHash]);
      if (result.rowCount) await client.query("DELETE FROM sessions WHERE sess->>'userId'=$1 AND sid<>$2", [id,currentSessionId || '']);
      await client.query('COMMIT');
      return result.rowCount > 0;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async createAuthToken(userId, purpose, tokenHash, expiresAt) {
    await this.pool.query('DELETE FROM auth_tokens WHERE user_id=$1 AND purpose=$2', [userId,purpose]);
    await this.pool.query('INSERT INTO auth_tokens (token_hash,user_id,purpose,expires_at) VALUES ($1,$2,$3,$4)', [tokenHash,userId,purpose,expiresAt]);
  }
  async consumeVerificationToken(tokenHash) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const token = await client.query("SELECT user_id FROM auth_tokens WHERE token_hash=$1 AND purpose='verify_email' AND used_at IS NULL AND expires_at>now() FOR UPDATE", [tokenHash]);
      if (!token.rowCount) { await client.query('ROLLBACK'); return null; }
      const userId = token.rows[0].user_id;
      const { rows } = await client.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1 RETURNING id,name,email,email_verified_at AS "emailVerifiedAt"', [userId]);
      await client.query("UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND purpose='verify_email' AND used_at IS NULL", [userId]);
      await client.query('COMMIT');
      return rows[0] || null;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async consumePasswordResetToken(tokenHash, passwordHash) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const token = await client.query("SELECT user_id FROM auth_tokens WHERE token_hash=$1 AND purpose='password_reset' AND used_at IS NULL AND expires_at>now() FOR UPDATE", [tokenHash]);
      if (!token.rowCount) { await client.query('ROLLBACK'); return false; }
      const userId = token.rows[0].user_id;
      await client.query('UPDATE users SET password_hash=$2 WHERE id=$1', [userId,passwordHash]);
      await client.query("UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND purpose='password_reset' AND used_at IS NULL", [userId]);
      await client.query("DELETE FROM sessions WHERE sess->>'userId'=$1", [userId]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async consumeRateLimit(key, limit, windowSeconds) {
    const { rows } = await this.pool.query(`INSERT INTO auth_rate_limits (key,window_started_at,hits) VALUES ($1,now(),1)
      ON CONFLICT (key) DO UPDATE SET
        hits=CASE WHEN auth_rate_limits.window_started_at + ($2 * interval '1 second') <= now() THEN 1 ELSE auth_rate_limits.hits+1 END,
        window_started_at=CASE WHEN auth_rate_limits.window_started_at + ($2 * interval '1 second') <= now() THEN now() ELSE auth_rate_limits.window_started_at END
      RETURNING hits,GREATEST(1,ceil(extract(epoch FROM (window_started_at + ($2 * interval '1 second') - now()))))::int AS "retryAfter"`, [key,windowSeconds]);
    const result = { allowed: rows[0].hits <= limit, retryAfter: rows[0].retryAfter };
    if (Math.random() < 0.01) this.pool.query("DELETE FROM auth_rate_limits WHERE window_started_at < now() - interval '2 days'").catch(() => {});
    return result;
  }
  async getPreferences(userId) {
    const { rows } = await this.pool.query(`SELECT u.id,u.name,u.email,
      s.check_interval_seconds AS "checkIntervalSeconds", s.timeout_seconds AS "timeoutSeconds",
      s.email_alerts AS "emailAlerts", COALESCE(s.alert_email,u.email) AS "alertEmail",
      s.alert_on_down AS "alertOnDown", s.alert_on_recovery AS "alertOnRecovery"
      FROM users u JOIN user_settings s ON s.user_id=u.id WHERE u.id=$1`, [userId]);
    if (!rows[0]) return null;
    const row = rows[0];
    return { profile: { id: row.id, name: row.name, email: row.email }, monitoring: { checkIntervalSeconds: row.checkIntervalSeconds, timeoutSeconds: row.timeoutSeconds }, notifications: { emailAlerts: row.emailAlerts, alertEmail: row.alertEmail, alertOnDown: row.alertOnDown, alertOnRecovery: row.alertOnRecovery } };
  }
  async updateMonitoring(userId, { checkIntervalSeconds, timeoutSeconds }) {
    await this.pool.query('UPDATE user_settings SET check_interval_seconds=$2,timeout_seconds=$3,updated_at=now() WHERE user_id=$1', [userId,checkIntervalSeconds,timeoutSeconds]);
    return this.getPreferences(userId);
  }
  async updateNotifications(userId, { emailAlerts, alertEmail, alertOnDown, alertOnRecovery }) {
    await this.pool.query('UPDATE user_settings SET email_alerts=$2,alert_email=$3,alert_on_down=$4,alert_on_recovery=$5,updated_at=now() WHERE user_id=$1', [userId,emailAlerts,alertEmail,alertOnDown,alertOnRecovery]);
    return this.getPreferences(userId);
  }

  async listGroups(userId) {
    const { rows } = await this.pool.query(`SELECT g.id,g.name,g.color,count(a.id)::int AS "appCount"
      FROM app_groups g LEFT JOIN apps a ON a.user_id=g.user_id AND a.group_name=g.name
      WHERE g.user_id=$1 GROUP BY g.id ORDER BY lower(g.name)`, [userId]);
    return rows;
  }
  async createGroup(userId, { name, color }) {
    const { rows } = await this.pool.query('INSERT INTO app_groups (id,user_id,name,color) VALUES ($1,$2,$3,$4) RETURNING id,name,color', [randomUUID(),userId,name,color]);
    return { ...rows[0], appCount: 0 };
  }
  async updateGroup(userId, id, { name, color }) {
    const previous = await this.pool.query('SELECT name FROM app_groups WHERE id=$1 AND user_id=$2', [id,userId]);
    if (!previous.rowCount) return null;
    if (previous.rows[0].name === 'Unassigned' && name !== 'Unassigned') throw Object.assign(new Error('The Unassigned group name is reserved.'), { code: 'GROUP_RESERVED' });
    const { rows } = await this.pool.query('UPDATE app_groups SET name=$3,color=$4 WHERE id=$1 AND user_id=$2 RETURNING id,name,color', [id,userId,name,color]);
    if (!rows[0]) return null;
    const { rows: countRows } = await this.pool.query('SELECT count(*)::int AS count FROM apps WHERE user_id=$1 AND group_name=$2', [userId,name]);
    return { ...rows[0], appCount: countRows[0].count };
  }
  async removeGroup(userId, id) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const group = await client.query('SELECT name FROM app_groups WHERE id=$1 AND user_id=$2 FOR UPDATE', [id,userId]);
      if (!group.rowCount || group.rows[0].name === 'Unassigned') { await client.query('ROLLBACK'); return false; }
      await client.query("UPDATE apps SET group_name='Unassigned' WHERE user_id=$1 AND group_name=$2", [userId,group.rows[0].name]);
      await client.query('DELETE FROM app_groups WHERE id=$1 AND user_id=$2', [id,userId]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async list(userId, { search = '', group = '' } = {}) {
    const { rows } = await this.pool.query(`SELECT ${appFields}, COALESCE((
      SELECT json_agg(json_build_object('status', h.status, 'latency', h.latency, 'time', h.checked_at) ORDER BY h.checked_at)
      FROM check_history h WHERE h.app_id=a.id
    ), '[]'::json) AS history FROM apps a
      WHERE a.user_id=$1 AND ($2='' OR a.name ILIKE '%'||$2||'%' OR a.url ILIKE '%'||$2||'%' OR a.group_name ILIKE '%'||$2||'%')
      AND ($3='' OR lower(a.group_name)=lower($3)) ORDER BY a.created_at DESC`, [userId, search, group]);
    return rows.map(mapApp);
  }
  async listAllIds() {
    const { rows } = await this.pool.query('SELECT id FROM apps ORDER BY created_at');
    return rows.map(row => row.id);
  }
  async listSchedules() {
    const { rows } = await this.pool.query(`SELECT a.user_id AS "userId", s.check_interval_seconds AS "checkIntervalSeconds",
      array_agg(a.id ORDER BY a.created_at) AS ids FROM apps a
      JOIN user_settings s ON s.user_id=a.user_id GROUP BY a.user_id,s.check_interval_seconds`);
    return rows;
  }
  async get(userId, id) {
    const { rows } = await this.pool.query(`SELECT ${appFields}, COALESCE((
      SELECT json_agg(json_build_object('status', h.status, 'latency', h.latency, 'time', h.checked_at) ORDER BY h.checked_at)
      FROM check_history h WHERE h.app_id=a.id
    ), '[]'::json) AS history FROM apps a WHERE a.id=$1 AND a.user_id=$2`, [id, userId]);
    return mapApp(rows[0]);
  }
  async getForCheck(id) {
    const { rows } = await this.pool.query(`SELECT a.id,a.url,s.timeout_seconds AS "timeoutSeconds"
      FROM apps a JOIN user_settings s ON s.user_id=a.user_id WHERE a.id=$1`, [id]);
    return rows[0] || null;
  }
  async getHistory(userId, id, limit) {
    const owned = await this.pool.query('SELECT id FROM apps WHERE id=$1 AND user_id=$2', [id, userId]);
    if (!owned.rowCount) return null;
    const { rows } = await this.pool.query("SELECT status, latency, checked_at AS time FROM check_history WHERE app_id=$1 ORDER BY checked_at DESC LIMIT $2", [id, limit]);
    return { id, history: rows.reverse().map(row => ({ ...row, latency: Number(row.latency) })) };
  }
  async create(userId, fields) {
    const id = randomUUID();
    await this.pool.query('INSERT INTO apps (id,user_id,name,url,group_name,x,y) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id,userId,fields.name,fields.url,fields.group,fields.x,fields.y]);
    return this.get(userId, id);
  }
  async update(userId, id, fields) {
    const columns = { name: 'name', url: 'url', group: 'group_name', x: 'x', y: 'y' };
    const entries = Object.entries(fields).filter(([key]) => columns[key]);
    if (!entries.length) return this.get(userId, id);
    const params = entries.map(([, value]) => value);
    const sets = entries.map(([key], i) => `${columns[key]}=$${i + 1}`);
    params.push(id, userId);
    const result = await this.pool.query(`UPDATE apps SET ${sets.join(',')} WHERE id=$${params.length - 1} AND user_id=$${params.length}`, params);
    return result.rowCount ? this.get(userId, id) : null;
  }
  async remove(userId, id) {
    const result = await this.pool.query('DELETE FROM apps WHERE id=$1 AND user_id=$2', [id,userId]);
    return result.rowCount > 0;
  }
  async updateCheck(id, result, checkedAt) {
    const client = await this.pool.connect();
    let userId;
    let app;
    try {
      await client.query('BEGIN');
      const before = await client.query('SELECT status,user_id FROM apps WHERE id=$1 FOR UPDATE', [id]);
      if (!before.rowCount) { await client.query('ROLLBACK'); return null; }
      const previousStatus = before.rows[0].status;
      userId = before.rows[0].user_id;
      await client.query('UPDATE apps SET status=$2,latency=$3,error=$4,checked_at=$5 WHERE id=$1', [id,result.status,result.latency,result.error,checkedAt]);
      await client.query('INSERT INTO check_history (app_id,status,latency,error,checked_at) VALUES ($1,$2,$3,$4,$5)', [id,result.status,result.latency,result.error,checkedAt]);
      await client.query('DELETE FROM check_history WHERE app_id=$1 AND id NOT IN (SELECT id FROM check_history WHERE app_id=$1 ORDER BY checked_at DESC LIMIT 100)', [id]);
      const current = await client.query(`SELECT ${appFields}, COALESCE((
        SELECT json_agg(json_build_object('status', h.status, 'latency', h.latency, 'time', h.checked_at) ORDER BY h.checked_at)
        FROM check_history h WHERE h.app_id=a.id
      ), '[]'::json) AS history FROM apps a WHERE a.id=$1 AND a.user_id=$2`, [id,userId]);
      app = mapApp(current.rows[0]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return { app, previousStatus, userId };
  }
}
