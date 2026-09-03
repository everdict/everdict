-- 0208_created_worlds — additive (expand): the worklist of worlds Everdict CREATED for a case.
-- A static world is somebody else's and a session world is somebody else's to expire; a world this platform
-- made is the only one where "we could not find out whether it is gone" costs money, so it is the only one
-- with a ledger. `released` is written ONLY after a read-back said the world is not standing (protocol L5).
-- Design: docs/architecture/world-and-engagement-model.md (landing order 3.9).
CREATE TABLE IF NOT EXISTS everdict_created_worlds (
  id          text PRIMARY KEY,
  tenant      text NOT NULL,
  run_id      text NOT NULL,
  environment text NOT NULL,           -- "id@version" — a leak names the version it came from
  target      text,                    -- the registered runtime it stands on; a sweep has no case to ask
  state       text NOT NULL,           -- creating | created | releasing | released | unknown
  services    jsonb NOT NULL,          -- what to tear down, kept so a sweep needs no registry read
  attempts    integer NOT NULL DEFAULT 0,
  detail      text,                    -- why `unknown` — the sentence an operator reads
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The reconciler's read: everything still owed, oldest first.
CREATE INDEX IF NOT EXISTS everdict_created_worlds_owed_idx
  ON everdict_created_worlds (updated_at)
  WHERE state <> 'released';
CREATE INDEX IF NOT EXISTS everdict_created_worlds_tenant_idx ON everdict_created_worlds (tenant, run_id);
