import type { TraceEvent } from "@everdict/contracts";
import { Run, type RunTransition } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RunStore } from "../ports/run-store.js";
import { settleRun } from "../ports/settle.js";

// Shared by the two per-task drivers (SessionTaskRunner = process harness, FrontDoorTurnRunner = service
// conversation): the capped live buffer and the first-terminal-write-wins child settle.

// The live buffer cap: a runaway harness can't grow the process without bound. The cap is on the CURSOR
// buffer (what the web polls); when hit, one error marker records the truncation and further events drop.
export const MAX_TASK_EVENTS = 5000;

export function appendCapped(events: TraceEvent[], ev: TraceEvent): void {
  if (events.length < MAX_TASK_EVENTS) {
    events.push(ev);
    return;
  }
  if (events.length === MAX_TASK_EVENTS) {
    events.push({
      t: ev.t,
      kind: "error",
      message: `[everdict] event buffer full (${MAX_TASK_EVENTS}) — further events dropped`,
    });
  }
}

export interface FinalizeDeps {
  store: RunStore;
  events?: PlatformEventEmitter;
  newId: () => string;
  now: () => string;
}

// FIRST TERMINAL WRITE WINS — and it says so in SQL, not only in this comment (arch-review 27 P0). This is
// the shared settle every session-shaped driver goes through, and it was read-check-write: the `get` above is
// a snapshot, and the writer that finished this run can be in another process. Two settles both read a
// running row, both wrote, and the LAST one won — the exact inverse of the rule the function is named after.
//
// …AND A CAS LOSER PUBLISHES NOTHING. The facts were stamped before the write and pushed after it without
// looking at whether the write landed. The Pg adapter is correct — a guarded update that matches no row
// inserts no outbox event either — so the DURABLE record was already right; what leaked was the LIVE push,
// which in this platform is not a UI notification but the input to agent activation. A rejected state whose
// side effects still fire is a rejection nobody downstream heard.
//
// Returns whether the transition applied — `false` now means "somebody else settled it", which is the only
// honest reading of a lost CAS.
export async function finalizeRun(
  deps: FinalizeDeps,
  runId: string,
  tenant: string,
  fn: (run: Run) => RunTransition,
): Promise<boolean> {
  const current = await deps.store.get(runId);
  if (!current || Run.from(current).isTerminal()) return false;
  const transition = fn(Run.from(current));
  const stamped = stampFacts(tenant, transition.facts, { newId: deps.newId, now: deps.now });
  const settled = await settleRun(
    deps.store,
    runId,
    transition.patch,
    stamped.map((f) => f.record),
  );
  if (settled === undefined) return false;
  if (stamped.length > 0) void deps.events?.pushPersisted?.(stamped);
  return true;
}
