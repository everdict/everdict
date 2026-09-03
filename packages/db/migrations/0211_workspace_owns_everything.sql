-- 0211_workspace_owns_everything — EXPAND: the workspace becomes the only owner, and the only minter.
--
-- The team was seven things at once (docs/tracker.md): an ownership axis on fourteen tables, the minter of
-- issue identifiers (`ENG-12`), a nesting tree, a roster, a read ceiling (`isPrivate` → `visibleTeams`), a
-- cycle cadence, and a write gate (`canReachTeam`). All of it collapses into the workspace, which was always
-- the tenancy boundary underneath it.
--
-- This file is the EXPAND half (rule `db`: expand → deploy → contract). It ADDS what the workspace needs to
-- take over and leaves every `team_id` column in place, so a replica still running the previous release keeps
-- reading its own rows while the new one ignores them. The CONTRACT half — dropping those columns and the
-- team/cycle tables — is `0212`, and it must not run until `scripts/live/migrate-teams-to-workspace.mjs` has.
--
-- ⚠️ THE IDENTIFIER PREFIX CHANGES, AND THAT IS A DECISION, NOT A CONSEQUENCE. `ENG-12` is a public address:
-- it is in pull requests and chat. The maintainer chose to RE-ISSUE every identifier under one workspace key
-- rather than freeze the old ones, so links that name the old prefix stop resolving. The script records the
-- old identifier on the issue's `former_identifiers`, which is the same field a team move already used — so
-- the history says what each issue used to be called even though the address no longer answers.

-- ── ① THE WORKSPACE MINTS ──────────────────────────────────────────────────────────────────────────
--
-- `issue_key` is the prefix, immutable after the first identifier is minted under it, exactly as a team key
-- was. `issue_counter` is the sequence — a column rather than `max(number)+1` so allocation stays ONE
-- conditional `UPDATE … RETURNING` and two concurrent files can never take the same number.
--
-- Both are NULLABLE here and filled by the script: a default in SQL would have to invent a key from the
-- workspace id, and a workspace whose id is `acme-platform-eu` has no obvious 2–6 character name. The script
-- derives one, reports it, and lets an operator override it — which is the kind of choice a migration should
-- not make silently.
ALTER TABLE everdict_workspaces ADD COLUMN IF NOT EXISTS issue_key text;
ALTER TABLE everdict_workspaces ADD COLUMN IF NOT EXISTS issue_counter integer NOT NULL DEFAULT 0;

-- ── ② THE INDEXES THE READS NEED ONCE THE TEAM IS NOT IN THE PATH ─────────────────────────────────
--
-- Every issue-list index from 0105/0116 leads with `(tenant, team_id, …)`. With no team in the path the
-- planner can use none of them for the list this product actually draws now — the workspace-wide one — so it
-- would Seq Scan + top-N sort, which is what 0116 was written to remove in the first place.
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_updated_idx ON everdict_issues (tenant, updated_at DESC);
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_status_updated_idx
  ON everdict_issues (tenant, status, updated_at DESC);

-- One identifier per workspace, which is what makes `GET /issues/EVD-12` a lookup rather than a scan — and
-- what stops the re-issue from minting the same name twice. Partial: rows the script has not reached yet
-- still carry their old prefix and must not collide with each other while it works.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_issues_tenant_identifier_uidx
  ON everdict_issues (tenant, identifier)
  WHERE identifier IS NOT NULL;

-- ── ③ WORKFLOW STATES ARE THE WORKSPACE'S BOARD ───────────────────────────────────────────────────
--
-- A board column was a team's. There is one board now, so the uniqueness that used to be per (tenant, team)
-- becomes per tenant. The old index is left for the contract phase to drop.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_workflow_states_tenant_name_uidx
  ON everdict_workflow_states (tenant, lower(name));
