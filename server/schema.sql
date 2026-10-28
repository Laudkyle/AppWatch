CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_groups (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  color TEXT NOT NULL DEFAULT '#6d8df4' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS app_groups_user_lower_name_idx ON app_groups(user_id, lower(name));

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  check_interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (check_interval_seconds BETWEEN 30 AND 3600),
  timeout_seconds INTEGER NOT NULL DEFAULT 8 CHECK (timeout_seconds BETWEEN 2 AND 60),
  email_alerts BOOLEAN NOT NULL DEFAULT false,
  alert_email TEXT,
  alert_on_down BOOLEAN NOT NULL DEFAULT true,
  alert_on_recovery BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS apps (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  url TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT 'Unassigned',
  x DOUBLE PRECISION NOT NULL DEFAULT 50,
  y DOUBLE PRECISION NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('up', 'down', 'unknown')),
  latency INTEGER,
  checked_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apps_user_id_idx ON apps(user_id);

-- Backfill settings and groups on upgrades, then enforce group ownership on app records.
INSERT INTO user_settings (user_id) SELECT id FROM users ON CONFLICT (user_id) DO NOTHING;
INSERT INTO app_groups (id, user_id, name, color)
  SELECT gen_random_uuid(), id, 'Production', '#6d8df4' FROM users
  ON CONFLICT (user_id, name) DO NOTHING;
INSERT INTO app_groups (id, user_id, name, color)
  SELECT gen_random_uuid(), id, 'Unassigned', '#8993a2' FROM users
  ON CONFLICT (user_id, name) DO NOTHING;
INSERT INTO app_groups (id, user_id, name, color)
  SELECT gen_random_uuid(), user_id, group_name, '#6d8df4' FROM apps
  ON CONFLICT (user_id, name) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apps_user_group_fk') THEN
    ALTER TABLE apps ADD CONSTRAINT apps_user_group_fk
      FOREIGN KEY (user_id, group_name) REFERENCES app_groups(user_id, name) ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS check_history (
  id BIGSERIAL PRIMARY KEY,
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('up', 'down')),
  latency INTEGER NOT NULL,
  error TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS check_history_app_time_idx ON check_history(app_id, checked_at DESC);
