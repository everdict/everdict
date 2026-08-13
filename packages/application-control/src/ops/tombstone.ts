import type { RunRecord } from "@everdict/contracts";
import { Run } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { RunStore } from "../ports/run-store.js";
import { settleRun } from "../ports/settle.js";
import { INTERRUPTED } from "./startup-recovery.js";

// ── A TERMINAL ROW IS NOT A TERMINAL FACT ────────────────────────────────────────────────────────────
//
// Every recovery tombstone used to write a raw `{status: "failed", error: INTERRUPTED}` patch and stop there.
// That is a row the ledger agrees with and an event the world never hears — which was invisible until the
// run's completion callback started hanging off the terminal fact, and then it meant this: the callback fired
// for runs that ended normally and stayed silent for exactly the runs the durable callback was built for, the
// ones whose original process died. The caller waits forever, and the only trace is a `failed` row nobody was
// told about.
//
// So the tombstone goes through the DOMAIN transition, like every other settlement: `fail` computes the same
// `run.failed` fact a normal failure emits, it is stamped and persisted in the settlement's own transaction,
// and the live bus hears it only if the write landed.
export async function tombstoneInterrupted(
  runs: RunStore,
  record: RunRecord,
  clock: { now: () => string; newId: () => string },
  opts?: { epoch?: number; events?: { pushPersisted?: (facts: ReturnType<typeof stampFacts>) => void } },
): Promise<RunRecord | undefined> {
  // The domain refuses a terminal record, which is the honest answer for a row that settled since the read —
  // the caller has nothing to tombstone.
  const run = Run.from(record);
  if (run.isTerminal()) return undefined;
  const transition = run.fail(INTERRUPTED, clock.now());
  const stamped = stampFacts(record.tenant, transition.facts, { newId: clock.newId, now: clock.now });
  const settled = await settleRun(
    runs,
    record.id,
    transition.patch,
    stamped.map((f) => f.record),
    opts?.epoch !== undefined ? { epoch: opts.epoch } : undefined,
  );
  // A CAS loser announces nothing: the guarded write inserted no durable event either.
  if (settled !== undefined && stamped.length > 0) opts?.events?.pushPersisted?.(stamped);
  return settled;
}
