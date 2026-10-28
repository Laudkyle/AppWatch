import 'dotenv/config';
import { pool, migrate } from './db.js';
import { PgStore } from './pg-store.js';
import { Monitor } from './monitor.js';
import { AlertService } from './alerts.js';
import { validateTargetSecurityConfig } from './target-security.js';

validateTargetSecurityConfig();
await migrate();

const lockConnection = await pool.connect();
let shuttingDown = false;
let monitor;
try {
  const { rows } = await lockConnection.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [72649, 11022027]);
  if (!rows[0].locked) {
    console.error('Another AppWatch monitoring worker already holds the scheduler lock.');
    lockConnection.release();
    await pool.end();
    process.exitCode = 1;
  } else {
    const store = new PgStore(pool);
    monitor = new Monitor(store, new AlertService(store));
    monitor.start();
    console.log('AppWatch monitoring worker started.');
  }
} catch (error) {
  lockConnection.release();
  await pool.end();
  throw error;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  monitor?.stop();
  await monitor?.waitForIdle();
  if (lockConnection) {
    try { await lockConnection.query('SELECT pg_advisory_unlock($1, $2)', [72649, 11022027]); }
    catch (error) { console.error('Could not release scheduler lock cleanly:', error.message); }
    lockConnection.release();
  }
  await pool.end();
}

if (monitor) {
  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
}
