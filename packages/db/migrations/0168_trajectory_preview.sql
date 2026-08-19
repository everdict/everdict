-- What a piece of evidence was ASKED TO DO.
--
-- mig 0124 gave every trajectory a `kind` + a `label`, which fixed rows that read `<run id> · run · N events`.
-- It did not fix the case that follows from what the label actually is: for every kind but `eval` the handle
-- is the run's HARNESS id (`runEvidenceIdentity`, @everdict/domain), and for an agent run that harness id is
-- the AGENT (`Run.newAgentRun`/`newChatTurn` set `harness.id = agentId`). One agent answering twenty questions
-- therefore produces twenty rows that all read `default <uuid>` — the handle names the PRODUCER, which is
-- constant across rows, never the WORK, which is the only thing that tells them apart. Evidence you cannot
-- recognize reads as evidence that is not there.
--
-- `preview` is the one-line excerpt naming the work: the member's own message, else the first tool call, else
-- the root span (`previewFromEvents`, @everdict/domain). It is derived from the BODY at seal, by the naming
-- decorator every seal path passes through, so it also names the rows no run record could name — OTLP door
-- arrivals and materialized imports.
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS preview text;

-- No backfill. Unlike mig 0124's `kind`/`label`, this value is not a column of some other table waiting to be
-- joined: it lives inside the sealed body, and re-deriving it here would mean parsing every historical jsonb
-- trajectory in one migration. Sealed evidence is never rewritten, so old rows keep the handle they were
-- sealed with (they still carry `kind` + `label`) and every row sealed from now on carries its own line.
