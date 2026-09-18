-- The orchestrator↔worker steering channel, made durable (DEFAUL-37).
--
-- `AgentMailbox` was a Map in the agent service's memory, and docs/architecture/agent-teams.md said so:
-- "a message not yet drained does not survive an agent-service restart". The roster's durable half
-- (everdict_agent_sessions.teammate) IS persisted and re-registered on boot — so the worker came back and
-- what it had been told did not. This table is the other half.
--
-- `seq` is a BIGSERIAL rather than a per-session counter on purpose: a MAX(seq)+1 insert makes two concurrent
-- deliveries a unique-violation to retry, and buys nothing the channel needs. What the channel promises is
-- that a sender holding the receipt for X before sending Y gets X before Y — a global monotonic sequence
-- gives exactly that, for every pair of rows in one session, without a race.
CREATE TABLE IF NOT EXISTS everdict_agent_inbox (
  id          text PRIMARY KEY,
  seq         bigserial NOT NULL,
  tenant      text NOT NULL,
  session_id  text NOT NULL,
  -- user | agent | event — the attribution the drain renders, so a restored turn still knows who is speaking.
  source      text NOT NULL,
  sender      text,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL,
  -- queued | delivered | discarded. NOT a nullable delivered_at: "the supervisor took it back" and "it is
  -- still waiting" are opposite readings and a NULL timestamp says only one of them.
  disposition text NOT NULL DEFAULT 'queued',
  settled_at  timestamptz
);

-- The drain's read AND its claim: everything still queued for one session, oldest first. Partial, because the
-- queued rows are the tiny live tail of a log that only grows.
CREATE INDEX IF NOT EXISTS everdict_agent_inbox_queued_idx
  ON everdict_agent_inbox (tenant, session_id, seq)
  WHERE disposition = 'queued';

-- The boot read: which sessions came back with unread instructions (cross-tenant, like the other reapers).
CREATE INDEX IF NOT EXISTS everdict_agent_inbox_queued_sessions_idx
  ON everdict_agent_inbox (seq)
  WHERE disposition = 'queued';
