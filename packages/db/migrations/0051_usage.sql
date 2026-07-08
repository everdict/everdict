-- Meter-only billing usage (docs/architecture/usage-metering.md): per-(tenant, source) accumulated LLM cost for the
-- billable surface (orchestration + verdict). The in-memory UsageMeter write-throughs here (best-effort) and hydrates
-- from it at boot (single-process read model). record = atomic ON CONFLICT increment. Additive.
CREATE TABLE IF NOT EXISTS everdict_usage (
  tenant text NOT NULL,
  source text NOT NULL,
  usd double precision NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  evaluations bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, source)
);
