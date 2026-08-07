-- Handoff checkpoints (ownership protocol O6, docs/architecture/ownership-protocol.md). An autonomous task
-- that stops at its envelope's boundary leaves a resumable state transfer behind — this is where it outlives
-- the process that wrote it. Without a table, "halt_checkpoint" halts and nothing is handed off.
--
-- APPEND-ONLY by design: the port offers no UPDATE and no DELETE, so a predecessor cannot rewrite the evidence
-- its successor already acted on. The record says what was actually known when work stopped, which is the
-- whole point of the confirmed-facts / hypotheses split it carries.
CREATE TABLE IF NOT EXISTS everdict_handoff_checkpoints (
  id          text        NOT NULL,
  tenant      text        NOT NULL,
  -- The TaskEnvelope this suspends. Envelopes themselves are not persisted (they are constructed per task from
  -- the agent spec + trigger), so this is a correlation key, not a foreign key.
  envelope_id text,
  -- The ownership role the predecessor worked AS — what tells a reader whether this carries an executor's
  -- claim or a verifier's verdict. NULL = unprofiled work.
  role        text,
  goal        text        NOT NULL,
  created_by  text        NOT NULL, -- member subject, or agent:<id>:<conversation>
  created_at  timestamptz NOT NULL,
  -- The full checkpoint contract (facts + refs, hypotheses, actions, plans, reproduction). Nothing reads a
  -- checkpoint's hypotheses without reading the checkpoint, so splitting the nested arrays into tables would
  -- buy queries nobody makes.
  body        jsonb       NOT NULL,
  PRIMARY KEY (tenant, id)
);

-- "How did this task stop, and what did it leave" — the question a successor arrives with, newest first.
CREATE INDEX IF NOT EXISTS everdict_handoff_checkpoints_tenant_envelope
  ON everdict_handoff_checkpoints (tenant, envelope_id, created_at DESC);
-- The workspace's handoff timeline (the list read, and the feed's backing query).
CREATE INDEX IF NOT EXISTS everdict_handoff_checkpoints_tenant_created
  ON everdict_handoff_checkpoints (tenant, created_at DESC, id DESC);
