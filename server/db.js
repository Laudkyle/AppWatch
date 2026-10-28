import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const { Pool } = pg;
const dirname = path.dirname(fileURLToPath(import.meta.url));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required. See .env.example.');

export const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});
pool.on('error', error => console.error('Unexpected PostgreSQL pool error:', error));

async function hasCompatibleAuthSecuritySchema(client) {
  const tables = await client.query(`SELECT
    to_regclass('users') IS NOT NULL AS users,
    to_regclass('sessions') IS NOT NULL AS sessions,
    to_regclass('auth_tokens') IS NOT NULL AS auth_tokens,
    to_regclass('auth_rate_limits') IS NOT NULL AS auth_rate_limits`);
  if (Object.values(tables.rows[0]).some(value => !value)) return false;
  const { rows: columns } = await client.query(`SELECT table_name,column_name
    FROM information_schema.columns WHERE table_schema=current_schema()
      AND (table_name,column_name) IN (
        ('users','email_verified_at'),
        ('sessions','sid'),('sessions','sess'),('sessions','expire'),
        ('auth_tokens','token_hash'),('auth_tokens','user_id'),('auth_tokens','purpose'),('auth_tokens','expires_at'),('auth_tokens','created_at'),('auth_tokens','used_at'),
        ('auth_rate_limits','key'),('auth_rate_limits','window_started_at'),('auth_rate_limits','hits')
      )`);
  const foundColumns = new Set(columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`));
  const expectedColumns = [
    'users.email_verified_at', 'sessions.sid', 'sessions.sess', 'sessions.expire',
    'auth_tokens.token_hash', 'auth_tokens.user_id', 'auth_tokens.purpose', 'auth_tokens.expires_at', 'auth_tokens.created_at', 'auth_tokens.used_at',
    'auth_rate_limits.key', 'auth_rate_limits.window_started_at', 'auth_rate_limits.hits'
  ];
  if (!expectedColumns.every(column => foundColumns.has(column))) return false;
  const { rows: indexes } = await client.query(`SELECT tablename,indexdef FROM pg_indexes
    WHERE schemaname=current_schema() AND tablename IN ('sessions','auth_tokens','auth_rate_limits')`);
  const sessionExpiry = indexes.some(({ tablename, indexdef }) => tablename === 'sessions' && /\(expire\)/i.test(indexdef));
  const tokenLookup = indexes.some(({ tablename, indexdef }) => tablename === 'auth_tokens' && /\(user_id, purpose, expires_at DESC\)/i.test(indexdef));
  const rateLimitWindow = indexes.some(({ tablename, indexdef }) => tablename === 'auth_rate_limits' && /\(window_started_at\)/i.test(indexdef));
  const { rows: constraints } = await client.query(`SELECT conrelid::regclass::text AS table_name,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid IN ('auth_tokens'::regclass,'auth_rate_limits'::regclass)`);
  const tokenPurpose = constraints.some(({ table_name, definition }) => table_name === 'auth_tokens' && /verify_email/.test(definition) && /password_reset/.test(definition));
  const tokenOwner = constraints.some(({ table_name, definition }) => table_name === 'auth_tokens' && /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i.test(definition));
  const positiveHits = constraints.some(({ table_name, definition }) => table_name === 'auth_rate_limits' && /CHECK \(\(hits > 0\)\)/i.test(definition));
  const tokenPrimaryKey = constraints.some(({ table_name, definition }) => table_name === 'auth_tokens' && definition === 'PRIMARY KEY (token_hash)');
  const rateLimitPrimaryKey = constraints.some(({ table_name, definition }) => table_name === 'auth_rate_limits' && definition === 'PRIMARY KEY (key)');
  return sessionExpiry && tokenLookup && rateLimitWindow && tokenPurpose && tokenOwner && positiveHits && tokenPrimaryKey && rateLimitPrimaryKey;
}

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [72649, 11022026]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const migrationDir = path.join(dirname, 'migrations');
    const files = (await fs.readdir(migrationDir)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name)).sort();
    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE version=$1', [file]);
      if (existing.rowCount) {
        if (existing.rows[0].checksum.trim() !== checksum) {
          if (file === '003_auth_security.sql' && await hasCompatibleAuthSecuritySchema(client)) {
            console.warn('Accepted a compatible pre-existing auth-security schema for migration 003; the recorded checksum remains unchanged.');
            continue;
          }
          throw new Error(`Applied migration ${file} was changed. Add a new migration instead.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version,checksum) VALUES ($1,$2)', [file,checksum]);
        await client.query('COMMIT');
        console.log(`Applied database migration ${file}`);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1, $2)', [72649, 11022026]); }
    finally { client.release(); }
  }
}
