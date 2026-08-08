import type { RunRecord } from "@everdict/contracts";
import { type RunTransition, assertRunNotTerminal, assertRunSession, terminalRunFacts } from "./run.js";

// SESSION-run policy (review §19): the transitions only a `lifetime: "session"` run has — close, snapshot,
// keep-alive. Split out of the Run aggregate so kind-specific lifecycle stops accreting into one class; the
// record, the ledger and the public vocabulary stay ONE (Run's methods delegate here), and every guard is
// the shared free function, never a module-local re-derivation.

// Close a session run (member close, TTL expiry, or orphan adoption by the reaper). A session ending is
// its NORMAL completion — expiry included — so every reason settles as succeeded; the reason is stamped
// on `session.closedReason` for the console. First terminal write wins (close vs expiry race).
export function closeSessionTransition(
  record: RunRecord,
  reason: "closed" | "expired" | "orphaned",
  now: string,
): RunTransition {
  assertRunNotTerminal(record, "closeSession");
  const session = record.session;
  return {
    patch: {
      status: "succeeded",
      ...(session !== undefined ? { session: { ...session, closedReason: reason } } : {}),
      updatedAt: now,
    },
    facts: terminalRunFacts(record, "succeeded"),
  };
}

// Agent worlds (W1): the session published a snapshot — an environment-capability version whose image IS
// this session's filesystem now exists, and the next session can boot from it. Append-only on the session
// half (one session may snapshot many times). The fact is deliberately NOT trigger-matchable in v1: an
// agent snapshotting on a trigger and waking on its own snapshot is loop guard #1's textbook vector.
export function recordSnapshotTransition(
  record: RunRecord,
  input: { world: string; version: string; image: string; now: string },
): RunTransition {
  assertRunNotTerminal(record, "recordSnapshot");
  const session = assertRunSession(record, "recordSnapshot");
  return {
    patch: {
      session: {
        ...session,
        snapshots: [...(session.snapshots ?? []), { version: input.version, image: input.image, at: input.now }],
      },
      updatedAt: input.now,
    },
    facts: [
      {
        kind: "run.snapshotted",
        subject: { type: "run", id: record.id },
        ...(record.createdBy !== undefined ? { actor: record.createdBy } : {}),
        payload: { world: input.world, version: input.version, image: input.image },
      },
    ],
  };
}

// Keep-alive (touch): push the hard deadline OUT to now+ttl — never pull it in (a touch that could shorten
// a long-remaining session would make a small ttl a foot-gun), and never announce (upkeep is not news).
export function extendSessionTransition(record: RunRecord, ttlSec: number, now: string): RunTransition {
  assertRunNotTerminal(record, "extendSession");
  const session = assertRunSession(record, "extendSession");
  const proposed = new Date(now).getTime() + ttlSec * 1000;
  const expiresAt = new Date(Math.max(new Date(session.expiresAt).getTime(), proposed)).toISOString();
  return { patch: { session: { ...session, ttlSec, expiresAt }, updatedAt: now }, facts: [] };
}
