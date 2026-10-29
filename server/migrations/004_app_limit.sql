ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS app_limit INTEGER NOT NULL DEFAULT 25;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='user_settings_app_limit_check'
      AND conrelid='user_settings'::regclass
  ) THEN
    ALTER TABLE user_settings ADD CONSTRAINT user_settings_app_limit_check
      CHECK (app_limit BETWEEN 1 AND 1000);
  END IF;
END $$;
