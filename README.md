# AppWatch

AppWatch is a React and Express application monitor. PostgreSQL stores accounts, app targets, groups, account preferences, sessions, and health-check history. App data and settings are scoped to the signed-in account.

## Local setup

1. Ensure PostgreSQL is running and the `appwatch` database exists.
2. Copy `.env.example` to `.env`. Set `DATABASE_URL` to your PostgreSQL username, password, host, and `appwatch` database. Set `SESSION_SECRET` to a random value of at least 32 characters.
3. Run `npm install`.
4. Run `npm run dev` and open the Vite address shown in the terminal.

The API listens on port 3001. Vite proxies `/api` to it. The server creates or upgrades tables from `server/schema.sql` at startup. The signup page creates the initial account; new accounts start with Production and Unassigned groups. For production, serve the built UI and API from one HTTPS origin, set `COOKIE_SECURE=true`, and use a protected session secret.

## Settings and notifications

- **Profile:** update account name and email.
- **Password:** change the password after confirming the current one.
- **Monitoring defaults:** set a per-account check interval from 30 seconds to 60 minutes and a request timeout from 2 to 60 seconds. The scheduler picks up preference changes within five seconds; new apps are checked immediately.
- **Email alerts:** set the destination and choose outage and/or recovery messages. Alerts are sent only on state transitions, not on every poll. Use **Send test email** to confirm SMTP delivery.
- **Groups:** create, rename, recolor, and delete groups. Deleting a group moves its apps to Unassigned; that required group cannot be renamed or deleted.

Email delivery is optional. Add your provider details to `.env` and restart the server:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=AppWatch <alerts@example.com>
```

`SMTP_SECURE=true` is typically used with implicit TLS on port 465. The backend does not store SMTP credentials in PostgreSQL. If SMTP is not configured, preferences can still be saved, but emails are not sent and the Settings page reports that delivery is not configured.

## API

All endpoints return JSON and use `/api`. Except for health and auth endpoints, routes require the signed-in session.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Backend and database health |
| `POST` | `/auth/signup` | Create account and sign in |
| `POST` | `/auth/login` | Sign in |
| `POST` | `/auth/logout` | Sign out |
| `GET` | `/auth/me` | Get current account |
| `GET` | `/settings` | Read profile, monitoring, notification, delivery, and group settings |
| `PUT` | `/settings/profile` | Update name and email |
| `PUT` | `/settings/password` | Change password with current-password confirmation |
| `PUT` | `/settings/monitoring` | Save check interval and timeout |
| `PUT` | `/settings/notifications` | Save alert email and event preferences |
| `POST` | `/settings/test-alert` | Send a test email |
| `GET` / `POST` | `/groups` | List or create a group |
| `PUT` / `DELETE` | `/groups/:id` | Rename/recolor or delete a group |
| `GET` / `POST` | `/apps` | List or create monitored apps |
| `GET` / `PUT` / `DELETE` | `/apps/:id` | Read, update, or delete an owned app |
| `GET` | `/apps/:id/history?limit=24` | Read check history (up to 100 records) |
| `POST` | `/apps/:id/check` | Check one app immediately |
| `POST` | `/check` | Check the signed-in account's apps immediately |

Checks use HTTP/HTTPS `HEAD`, falling back to a one-byte ranged `GET`; responses below HTTP 500 count as reachable. ICMP ping is not used. Configure access controls before allowing untrusted users to register, since they can submit endpoints for the server to check.
