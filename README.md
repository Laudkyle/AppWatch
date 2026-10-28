# AppWatch

AppWatch is a React and Express application monitor. PostgreSQL stores user accounts, app targets, monitor status, session records, and recent health-check history. Each account can only access its own monitored applications.

## Local setup

1. Copy `.env.example` to `.env`.
2. Set the password in `DATABASE_URL` to the password for your PostgreSQL `postgres` user. The URL already points to your `appwatch` database on `localhost:5432`.
3. Replace `SESSION_SECRET` with a random value of at least 32 characters.
4. Run `npm install`.
5. Run `npm run dev`; open the Vite address shown in the terminal.

The API runs on port 3001. Database tables are created on startup from `server/schema.sql`. The initial user is created through the signup page. There are no default or shared app records.

For production, set `COOKIE_SECURE=true`, use HTTPS, set `CORS_ORIGIN` only if the UI is hosted on a different origin, and provide a PostgreSQL connection with suitable SSL settings. `DATABASE_SSL=true` enables TLS; `DATABASE_SSL_REJECT_UNAUTHORIZED=false` is available for providers that require nonstandard certificates. `PORT`, `DATABASE_POOL_SIZE`, `CHECK_TIMEOUT_MS`, and `CHECK_CONCURRENCY` can also be configured.

## Authentication and data

- Signup and login use bcrypt password hashes and server-side sessions stored in PostgreSQL.
- The session cookie is HTTP-only, same-site, and expires after seven days.
- Every app CRUD and manual-check API request requires a signed-in session and is scoped to that account.
- App status changes and check history are written to PostgreSQL in the same transaction.
- Health checks run at startup and every 60 seconds. The checker sends `HEAD`, falling back to a one-byte ranged `GET`; responses below HTTP 500 count as reachable.

## API

All routes use JSON and are under `/api`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Database and scheduler health |
| `POST` | `/auth/signup` | Create account (`name`, `email`, `password`) and sign in |
| `POST` | `/auth/login` | Sign in (`email`, `password`) |
| `POST` | `/auth/logout` | End the current session |
| `GET` | `/auth/me` | Read the signed-in account |
| `GET` | `/apps` | List this account's apps; optional `search` and `group` filters |
| `POST` | `/apps` | Create an app (`name`, `url`, optional `group`, `x`, `y`) |
| `GET` | `/apps/:id` | Read one owned app |
| `PUT` | `/apps/:id` | Update supplied fields on one owned app |
| `DELETE` | `/apps/:id` | Remove one owned app |
| `GET` | `/apps/:id/history?limit=24` | Read recent check history |
| `POST` | `/apps/:id/check` | Check one owned app now |
| `POST` | `/check` | Check this account's apps now |

Checks support HTTP and HTTPS only; ICMP ping is not used. Configure access controls before allowing untrusted users to register, since registered users can submit endpoints for the server to check.
