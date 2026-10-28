import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../server/db.js';

const lockConnection = await pool.connect();
const { rows } = await lockConnection.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [72649, 11022028]);
if (!rows[0].locked) {
  console.error('Another AppWatch backup worker already holds the backup lock.');
  lockConnection.release();
  await pool.end();
  process.exit(1);
}

const backupScript = fileURLToPath(new URL('./backup.js', import.meta.url));
const intervalHours = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS || 24));
let stopping = false;
let activeChild;
let activeCompletion;

function runBackup() {
  if (stopping || activeChild) return;
  activeChild = spawn(process.execPath, [backupScript], { stdio: 'inherit', windowsHide: true, cwd: path.resolve(path.dirname(backupScript), '..') });
  activeChild.once('error', error => console.error('Could not start backup process:', error.message));
  activeCompletion = new Promise(resolve => activeChild.once('close', code => {
    activeChild = null;
    if (code !== 0) console.error(`Scheduled backup failed with exit code ${code ?? 'unknown'}.`);
    resolve();
  }));
}

runBackup();
const timer = setInterval(runBackup, intervalHours * 60 * 60 * 1000);
timer.unref();
async function shutdown() {
  stopping = true;
  clearInterval(timer);
  if (activeChild) { activeChild.kill('SIGTERM'); await activeCompletion; }
  try { await lockConnection.query('SELECT pg_advisory_unlock($1, $2)', [72649, 11022028]); }
  finally { lockConnection.release(); await pool.end(); }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
