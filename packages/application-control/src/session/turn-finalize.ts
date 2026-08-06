import type { TraceEvent } from "@everdict/contracts";
import { Run, type RunTransition } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RunStore } from "../ports/run-store.js";

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

// First terminal write wins — mirrors RunService.finalize. Returns whether the transition applied.
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
  await deps.store.update(
    runId,
    transition.patch,
    stamped.map((f) => f.record),
  );
  if (stamped.length > 0) void deps.events?.pushPersisted?.(stamped);
  return true;
}
