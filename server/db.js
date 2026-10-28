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
        if (existing.rows[0].checksum.trim() !== checksum) throw new Error(`Applied migration ${file} was changed. Add a new migration instead.`);
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
