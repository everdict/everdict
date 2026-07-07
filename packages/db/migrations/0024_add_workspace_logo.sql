-- Workspace logo (mutable display info). Like the avatar, holds an http(s) URL or a data:image base64 (resized to 256px in the web)
-- as-is — self-contained, no separate object storage. Just an added column, so additive (no preflight needed).
ALTER TABLE everdict_workspaces ADD COLUMN IF NOT EXISTS logo_url TEXT;
