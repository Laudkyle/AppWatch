import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { databaseEnvironment, runPostgresTool } from './postgres-command.js';

const backupFile = process.argv[2];
const source = process.env.DATABASE_URL;
const target = process.env.RESTORE_DATABASE_URL;
if (!backupFile) throw new Error('Provide a backup file: npm run db:restore -- backups/appwatch-YYYYMMDDTHHmmssZ.dump');
if (!source || !target) throw new Error('Set DATABASE_URL and an explicit RESTORE_DATABASE_URL before restoring.');
const absoluteBackup = path.resolve(backupFile);
const stat = await fs.stat(absoluteBackup).catch(() => null);
if (!stat?.isFile()) throw new Error(`Backup file does not exist: ${absoluteBackup}`);
const sourceUrl = new URL(source);
const targetUrl = new URL(target);
const databaseIdentity = url => `${url.hostname.toLowerCase()}:${url.port || '5432'}${decodeURIComponent(url.pathname)}`;
if (databaseIdentity(sourceUrl) === databaseIdentity(targetUrl)) throw new Error('Restore target matches DATABASE_URL. Choose a separate recovery database to protect the live database.');
await runPostgresTool(process.env.PG_RESTORE_PATH || 'pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', absoluteBackup], {
  ...process.env,
  ...databaseEnvironment(target, process.env.RESTORE_DATABASE_SSL === 'true')
});
console.log(`Backup restored to ${targetUrl.hostname}${targetUrl.pathname}.`);
