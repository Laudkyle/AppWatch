import { spawn } from 'node:child_process';

export function databaseEnvironment(connectionString, sslEnabled) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
    PGSSLMODE: sslEnabled ? (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false' ? 'require' : 'verify-full') : 'disable',
    ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {})
  };
}

export function runPostgresTool(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', windowsHide: true });
    child.once('error', error => reject(new Error(`Could not start ${command}. Install PostgreSQL command-line tools or set ${command === 'pg_dump' ? 'PG_DUMP_PATH' : 'PG_RESTORE_PATH'}. ${error.message}`)));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? 'unknown'}.`)));
  });
}
