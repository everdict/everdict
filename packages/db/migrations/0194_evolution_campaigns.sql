-- ── THE EVOLUTION CAMPAIGN SETTLEMENT (docs/architecture/evolution-lineage.md, Track D) ─────────────
--
-- The agent-evolve loop's discipline was prose in a skill body and a markdown journal the loop itself
-- edits — a decision (adoption) resting on a journal. This row is the settlement: the FRAME is frozen at
-- open and referenced by digest, the ROUNDS are the append-only trace of every hypothesis tested (the
-- store CASes on their count, so two concurrent loops cannot interleave a trace), and `close` is the pure
-- adoption gate's answer made durable. The issue beside it stays the narrative journal and intent hub.
--
-- `state` ∈ open | adopted | no_improvement | budget_exhausted — no CHECK constraint, for the reason the
-- attempt ledger has none: the refusing boundary is the schema in `@everdict/contracts`, and a new state
-- must not need a migration to be refusable.
CREATE TABLE IF NOT EXISTS everdict_evolution_campaigns (
  id           text PRIMARY KEY,
  tenant       text NOT NULL,
  issue_id     text NOT NULL,
  frame        jsonb NOT NULL,
  frame_digest text NOT NULL,
  rounds       jsonb NOT NULL DEFAULT '[]'::jsonb,
  state        text NOT NULL DEFAULT 'open',
  close        jsonb,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS everdict_evolution_campaigns_tenant_idx
  ON everdict_evolution_campaigns (tenant, created_at DESC, id DESC);
