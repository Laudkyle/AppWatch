import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseEnvironment, runPostgresTool } from './postgres-command.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupDir = path.resolve(root, process.env.BACKUP_DIR || 'backups');
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');
const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const destination = path.join(backupDir, `appwatch-${stamp}.dump`);
await fs.mkdir(backupDir, { recursive: true });
try {
  await runPostgresTool(process.env.PG_DUMP_PATH || 'pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', destination], {
    ...process.env,
    ...databaseEnvironment(connectionString, process.env.DATABASE_SSL === 'true')
  });
  console.log(`Database backup created: ${destination}`);
} catch (error) {
  await fs.rm(destination, { force: true }).catch(() => {});
  throw error;
}

const retentionDays = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS || 30));
const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
for (const entry of await fs.readdir(backupDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/^appwatch-\d{8}T\d{6}Z\.dump$/.test(entry.name)) continue;
  const fullPath = path.join(backupDir, entry.name);
  if ((await fs.stat(fullPath)).mtimeMs < cutoff) await fs.rm(fullPath);
}
