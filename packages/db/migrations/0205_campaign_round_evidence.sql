-- ── THE ROUND'S EVIDENCE, AS IMMUTABLE BYTES (docs/architecture/benchmark-evidence-spec.md §3) ─────────
--
-- A campaign round names what it saw by key + digest; this table holds the bytes. The key is content-addressed
-- (the digest is in it), so the primary key makes the write insert-once: a retry that lost the append race, or
-- a concurrent driver, writes the same document under the same name or a different document under a different
-- one — never a different document under the same name (rule `protocol` L4).
CREATE TABLE IF NOT EXISTS everdict_campaign_round_evidence (
  tenant      text NOT NULL,
  key         text NOT NULL,
  document    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, key)
);
