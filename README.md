# AppWatch

AppWatch is a React, Express, and PostgreSQL application monitor. PostgreSQL stores accounts, monitored endpoints, groups, account preferences, sessions, authentication tokens, rate-limit counters, and check history. Account data is scoped to the signed-in user.

## Local setup

1. Ensure PostgreSQL is running and the `appwatch` database exists. The default example URL uses the local `postgres` role; replace its password with your own.
2. Copy `.env.example` to `.env`. Set `DATABASE_URL` and a random `SESSION_SECRET` of at least 32 characters.
3. Run `npm install`.
4. Run `npm run dev` and open the Vite address shown in the terminal.

The development command starts the UI, API, and the separate monitor worker. The API listens on port 3001 and Vite proxies `/api` to it. Database migrations run automatically at startup and are recorded in `schema_migrations`. An applied migration is checksum-verified and must not be edited; add the next numbered SQL migration instead. A previously applied auth-security migration is accepted only when its checksum differs but the required tables, columns, indexes, and constraints are all present. PostgreSQL 13 or newer is recommended.

## Production startup

Build the UI with `npm run build`, then run the API with `npm start`. Run exactly one monitor worker with `npm run worker`; PostgreSQL advisory locking enforces one active scheduler even if an operator accidentally starts a second copy. Run one backup worker with `npm run backup:worker` for automatic backups. Use a service manager such as Windows Task Scheduler, NSSM, systemd, or a container supervisor to restart each process after a machine restart or failure.

Serve the API and built UI over one HTTPS origin where possible. Configure `COOKIE_SECURE=true`, a long random `SESSION_SECRET`, `CORS_ORIGIN` only if a separate UI origin is needed, and `APP_BASE_URL` as the public UI address used in account emails. Keep `.env`, SMTP credentials, PostgreSQL credentials, and backup files private. Use a PostgreSQL role with only the permissions AppWatch needs rather than a superuser for production.

## Email and account security

SMTP is required for new account creation, email verification, password recovery, and changing a verified account's email. Existing accounts from before email verification are marked verified by migration. New accounts cannot sign in until they verify their address. Verification links expire after 24 hours; password-reset links expire after one hour and are single-use. Changing a verified email revokes active sessions and requires verifying the new address.

Configure your SMTP provider in `.env` and restart the API:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=AppWatch <alerts@example.com>
APP_BASE_URL=https://appwatch.example.com
```

`SMTP_SECURE=true` is typically used with implicit TLS on port 465. Authentication endpoints use database-backed limits per client address and, when supplied, email identifier. The rate-limit state is shared between API instances. Failures to reach PostgreSQL fail closed for those endpoints.

Email delivery for monitoring alerts is also optional per account. Users can select an alert address, outage/recovery preferences, and send a test message in Settings. Alert messages are sent only on status transitions.

## Network destination safety

Monitored destinations accept only HTTP and HTTPS, cannot include embedded credentials, are resolved and checked on every probe, and are checked again for every redirect. The monitor pins its connection to the checked DNS result to prevent DNS rebinding. Private, loopback, link-local, reserved, and otherwise non-public addresses are blocked by default.

For trusted installations that must monitor private services, list only the required networks as comma-separated CIDRs in `MONITOR_ALLOWED_CIDRS`, for example:

```dotenv
MONITOR_ALLOWED_CIDRS=10.20.0.0/16,192.168.40.0/24,fd12:3456:789a::/48
```

Treat this allow-list as a server security boundary: any signed-in user allowed to add a target can then ask the worker to connect to addresses within those CIDRs. Do not allow broad internal networks unless that access is intended. Unresolvable hostnames can be saved, but they are checked against the same policy before each connection.

## Backups and restore

Install PostgreSQL command-line tools (`pg_dump` and `pg_restore`) on the server and make them available on `PATH`. If they are installed elsewhere, set `PG_DUMP_PATH` and `PG_RESTORE_PATH` to their executable paths. Configure `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, and `BACKUP_INTERVAL_HOURS` in `.env`. The backup worker makes a custom-format dump immediately at startup and then on the configured interval. It keeps only its own `appwatch-<UTC timestamp>.dump` files according to the retention period. Store the backup directory on protected storage and copy backups off the database host for disaster recovery.

Create a separate, empty recovery database and set `RESTORE_DATABASE_URL` to it. Stop AppWatch processes that would write to the recovery database, then restore a selected backup:

```powershell
$env:RESTORE_DATABASE_URL = 'postgresql://postgres:your-password@localhost:5432/appwatch_restore'
npm run db:restore -- backups/appwatch-20261028T120000Z.dump
```

Restore refuses to use the same host, port, and database name as `DATABASE_URL`; the command requires the explicit `RESTORE_DATABASE_URL` to reduce accidental production overwrites. It replaces matching objects in the target database, so use an empty recovery database. After restoring, point a temporary AppWatch instance at the recovery URL and verify sign-in, settings, apps, and history. Do a restore rehearsal regularly; a backup is useful only if it can be restored.

## Settings

- **Profile:** update the account name and verified email address.
- **Password:** change the password after confirming the current one; other signed-in sessions are revoked.
- **Monitoring defaults:** set the per-account interval (30 seconds to 60 minutes), request timeout (2 to 60 seconds), and application limit (1 to 1,000). The limit cannot be set below the number of apps already monitored.
- **Email alerts:** set the notification destination and choose outage and recovery alerts.
- **Groups:** create, rename, recolor, and delete groups. Deleting a group moves its apps to Unassigned; that required group cannot be renamed or deleted.
- **Appearance:** choose a saved light or dark theme. The profile menu at the upper right also provides theme shortcuts and account settings.

On the network map, drag an application to reposition it on its own, or drag a group label to move all apps in that group together. Positions are saved to PostgreSQL.

The **Availability** view charts recorded uptime and downtime over 24 hours, 7 days, 30 days, or 90 days. Reports can cover all applications, one group, or one app. A downtime incident begins at the first failed check and ends at the first successful recovery check; the prior successful check is recorded as the lower bound on when the outage began. Incident records are retained separately from the rolling 100-check detail history. Existing check history is backfilled where available when the downtime migration is applied.

The worker checks accounts according to each account's saved interval. New applications are checked immediately. Scheduled checks run in one worker process guarded by a PostgreSQL advisory lock; manually requested checks may also be initiated through the API.

## API

All endpoints return JSON and use `/api`. Except for health and auth endpoints, routes require a verified, signed-in session.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Backend and database health |
| `POST` | `/auth/signup` | Create an account and send a verification link |
| `POST` | `/auth/login` | Sign in after email verification |
| `POST` | `/auth/verify-email` | Consume a one-use email verification token |
| `POST` | `/auth/resend-verification` | Resend a verification link without revealing account existence |
| `POST` | `/auth/forgot-password` | Request a password-reset link without revealing account existence |
| `POST` | `/auth/reset-password` | Consume a one-use password-reset token |
| `POST` | `/auth/logout` | Sign out |
| `GET` | `/auth/me` | Get the current account |
| `GET` | `/settings` | Read profile, monitoring, notification, delivery, and group settings |
| `PUT` | `/settings/profile` | Update name or email; email changes require re-verification |
| `PUT` | `/settings/password` | Change password with current-password confirmation |
| `PUT` | `/settings/monitoring` | Save check interval, timeout, and app limit |
| `PUT` | `/settings/notifications` | Save alert email and event preferences |
| `POST` | `/settings/test-alert` | Send a test email |
| `GET` / `POST` | `/groups` | List or create a group |
| `PUT` / `DELETE` | `/groups/:id` | Rename/recolor or delete an owned group |
| `PUT` | `/groups/:id/map-position` | Move all app positions in an owned group by a relative offset |
| `GET` / `POST` | `/apps` | List or create monitored apps |
| `GET` / `PUT` / `DELETE` | `/apps/:id` | Read, update, or delete an owned app |
| `GET` | `/apps/:id/history?limit=24` | Read check history (up to 100 records) |
| `GET` | `/analytics/availability?range=24h&groupId=:id` | Availability series, downtime summary, and incidents for all apps, a group, or an app |
| `POST` | `/apps/:id/check` | Check one app immediately |
| `POST` | `/check` | Check the signed-in account's apps immediately |

Checks use HTTP/HTTPS `HEAD`, falling back to a one-byte ranged `GET` when the endpoint rejects `HEAD`; responses below HTTP 500 count as reachable. ICMP ping is not used. Configure `MONITOR_ALLOWED_CIDRS` deliberately before allowing untrusted users to register targets.
