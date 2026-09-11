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
//
// ── …AND `ttlSec` OBEYS THE SAME RULE, BECAUSE A DECISION READS IT (pnpm scan, domain, 2026-09-11) ──
//
// It used to take the caller's raw value on BOTH paths, so a touch that did not move the deadline still
// rewrote the field: a session granted 3600s and touched at 60s kept `expiresAt` an hour out and reported
// `ttlSec: 60`. Two fields on one record disagreeing about the same window.
//
// That is not cosmetic, because `ttlSec` is not a display value. `CampaignService`'s delegation budget
// refuses a round whose session was granted more time than the frozen frame allows, and its own message says
// "was granted ${n}s" — it reads THIS field. So a session with an hour left passed a two-minute budget, and
// `POST /sandboxes/:id/touch` reaches it on both transports with `ttlSec` OPTIONAL, which means the plain
// keep-alive path overwrites the grant with the deployment default without anybody asking for it.
//
// The field now says what the deadline says: the grant changes only when the deadline it implies WINS.
// `Math.max` on the instant, and the ttl that produced it — one fact, not two (rule `protocol` L3).
//
// ⚠️ WHAT THIS DOES NOT CLOSE: repeated touches still extend a session indefinitely, so a frame's
// `delegation.ttlSec` bounds the per-grant window and not the total time a delegate can hold one. That was
// true before this change and is unchanged by it; it is a different question about what the budget MEANS,
// and inventing an answer here would be a policy nobody declared.
export function extendSessionTransition(record: RunRecord, ttlSec: number, now: string): RunTransition {
  assertRunNotTerminal(record, "extendSession");
  const session = assertRunSession(record, "extendSession");
  const proposed = new Date(now).getTime() + ttlSec * 1000;
  const held = new Date(session.expiresAt).getTime();
  const granted = proposed > held ? ttlSec : session.ttlSec;
  const expiresAt = new Date(Math.max(held, proposed)).toISOString();
  return { patch: { session: { ...session, ttlSec: granted, expiresAt }, updatedAt: now }, facts: [] };
}
