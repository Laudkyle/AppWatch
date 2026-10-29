ALTER TABLE apps ADD COLUMN IF NOT EXISTS monitoring_started_at TIMESTAMPTZ;
UPDATE apps a SET monitoring_started_at = COALESCE(
  (SELECT min(h.checked_at) FROM check_history h WHERE h.app_id = a.id),
  a.checked_at
) WHERE a.monitoring_started_at IS NULL;

CREATE TABLE IF NOT EXISTS app_downtime_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  group_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  last_up_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (recovered_at IS NULL OR recovered_at >= started_at)
);
CREATE INDEX IF NOT EXISTS app_downtime_user_started_idx ON app_downtime_incidents(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS app_downtime_app_started_idx ON app_downtime_incidents(app_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS app_downtime_one_open_per_app_idx ON app_downtime_incidents(app_id) WHERE recovered_at IS NULL;

WITH ordered_checks AS (
  SELECT h.app_id, h.status, h.checked_at,
    lag(h.status) OVER (PARTITION BY h.app_id ORDER BY h.checked_at, h.id) AS previous_status,
    lag(h.checked_at) OVER (PARTITION BY h.app_id ORDER BY h.checked_at, h.id) AS previous_checked_at,
    lead(h.status) OVER (PARTITION BY h.app_id ORDER BY h.checked_at, h.id) AS next_status,
    lead(h.checked_at) OVER (PARTITION BY h.app_id ORDER BY h.checked_at, h.id) AS next_checked_at
  FROM check_history h
), outage_starts AS (
  SELECT * FROM ordered_checks
  WHERE status = 'down' AND previous_status IS DISTINCT FROM 'down'
)
INSERT INTO app_downtime_incidents (app_id,user_id,app_name,group_name,started_at,last_up_at,recovered_at)
SELECT o.app_id,a.user_id,a.name,a.group_name,o.checked_at,
  CASE WHEN o.previous_status = 'up' THEN o.previous_checked_at END,
  CASE WHEN o.next_status = 'up' THEN o.next_checked_at END
FROM outage_starts o JOIN apps a ON a.id = o.app_id;
