-- ONE CANCELLATION PROTOCOL, TWO KINDS OF TARGET (arch-review 52, Wave 3).
--
-- WHY. Mig 0184 gave a cancelled BATCH's teardown a durable owner. The standalone RUN lane runs the same
-- terminal-first protocol — commit failed{CANCELLED}, then abort the driver, revoke the lease, kill the
-- backend job — and had none of the ledger: `RunService.cancel`'s own comment named the caller's retry as
-- the teardown's owner, which is true of a 5xx and false of a crash. A control plane that died between the
-- commit and a successful kill left a run that is terminal in the ledger and still burning on the cluster,
-- with nothing in the system looking for the difference. That is the same gap 0184 closed, one scale down.
--
-- ADDITIVE. Every existing row is a scorecard operation, so the default is correct for all of them and no
-- backfill is needed. The primary key stays on the id column: run ids and scorecard ids are both UUIDs, so
-- a single-column key cannot collide across kinds, and widening the PK would rewrite a constraint the
-- reconciler's ON CONFLICT upserts depend on for no reachable benefit.
ALTER TABLE everdict_cancellation_operations
  ADD COLUMN IF NOT EXISTS target_kind text NOT NULL DEFAULT 'scorecard';

-- WHAT THE COMPLETION READ BACK (arch-review 52, Wave 3).
--
-- `completed` used to mean "the teardown function returned", which — with every arm underneath either
-- fire-and-forget or catch-and-continue — meant "the commands were issued". It means a re-read of the
-- postconditions now, and this column is what that read SAW: children re-listed terminal, the stop outcomes
-- that came back converged, the leases signalled, the causal subtree revoked. An operator asking "why does
-- the system believe this was torn down" gets the observations instead of a timestamp.
--
-- jsonb and unconstrained for the same reason `state` has no CHECK: the shape is the port's
-- (`CancellationCertificate`), and adding a field to it must never need a migration.
ALTER TABLE everdict_cancellation_operations
  ADD COLUMN IF NOT EXISTS certificate jsonb;

-- The reconciler's sweep is unchanged in shape — it reads EVERY incomplete operation and dispatches each
-- row to the teardown that knows its kind — so the existing partial index on (requested_at) WHERE
-- state <> 'completed' still covers it exactly. No second index: filtering by kind after the fact costs
-- nothing at the sweep's page size, and an index per kind would grow with a dimension nobody queries on.
