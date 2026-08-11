import { Run } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RunStore } from "../ports/run-store.js";

// The deployment-shape-independent half of the session-zombie safety net. The session lanes' own orphan
// sweeps (SandboxSessionService.sweepOrphans, the browser equivalent) reap containers AND settle rows — but
// they only exist where their lane is configured. A control plane WITHOUT a sandbox driver still reads the
// same ledger, and a row another process wrote and abandoned (a dev host stack, a replica that died) would
// sit `running` on it forever with nothing configured to end it. This sweep settles those rows from the
// ledger alone: no container is reachable from a lane that does not exist, so `orphaned` is the honest
// terminal. Lanes that ARE configured exclude their trigger — their own sweep owns the full teardown.
const DEFAULT_GRACE_MS = 120_000;

export async function settleOrphanSessionRuns(deps: {
  store: RunStore;
  events?: PlatformEventEmitter;
  // The triggers whose lane runs its OWN orphan sweep in this process — their rows are not ours to settle.
  excludeTriggers?: string[];
  graceMs?: number;
  newId?: () => string;
  now?: () => string;
}): Promise<number> {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const excluded = new Set(deps.excludeTriggers ?? []);
  const nowMs = new Date(now()).getTime();
  // A store hiccup must not take the caller's interval down with it — an empty pass just waits for the next.
  const rows = await deps.store.liveSessions().catch(() => []);
  let settled = 0;
  for (const row of rows) {
    if (row.expiresAt === undefined || Date.parse(row.expiresAt) + graceMs > nowMs) continue;
    const record = await deps.store.get(row.id).catch(() => undefined);
    if (!record || (record.trigger !== undefined && excluded.has(record.trigger))) continue;
    const run = Run.from(record);
    if (run.isTerminal()) continue;
    const transition = run.closeSession("orphaned", now());
    const stamped = stampFacts(record.tenant, transition.facts, { newId, now });
    // UNDER THE SETTLE CAS (arch-review 27 P0). This sweep exists to clean up rows OTHER PROCESSES left
    // behind, so its read-check-write is not a theoretical race — it is the sweep's normal working condition.
    // A lane finishing the session between the read above and this write would have had `succeeded` replaced
    // by `orphaned`, and the run would be recorded as abandoned work that in fact completed.
    const closed = await deps.store.update(
      row.id,
      transition.patch,
      stamped.map((f) => f.record),
      { expectNonTerminal: true },
    );
    // …and a lost CAS publishes nothing. The durable outbox already agreed (the guarded write inserts no
    // event when it matches no row); the live push is what would have told an agent that a session it is
    // watching went orphaned when it had actually succeeded.
    if (closed === undefined) continue;
    if (stamped.length > 0) void deps.events?.pushPersisted?.(stamped);
    settled += 1;
  }
  if (settled > 0)
    console.warn(`[session-sweep] settled ${settled} orphaned session run(s) no configured lane could end`);
  return settled;
}
