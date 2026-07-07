-- Per-workspace settings (control-plane policy). settings is JSONB for easy extension (currently: meterUsage).
CREATE TABLE IF NOT EXISTS everdict_workspace_settings (
  workspace  text PRIMARY KEY,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
