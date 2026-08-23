import {
  ACTIVATION_LEASE_MS,
  InMemoryCaseReceiptStore,
  InMemoryExecutionAttemptStore,
  ScorecardService,
} from "@everdict/application-control";
import { storedExecutionId } from "@everdict/contracts";
import type { CaseResult, KillOutcome, RuntimeWorkRef } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

// ── AN AUTHORIZED SUBMITTER IS LIVE WORK, EVEN BEFORE ITS OBJECT EXISTS (arch-review 59 P0) ──────────
//
// The teardown kills every handle the ledger holds and probes each one. When a dispatch has reserved and
// ACTIVATED but not yet created the external object, the cluster answers that probe truthfully: absent. That
// counted as convergence, so the certificate said zero, the operation closed — and the paused submitter then
// created the job. A cancellation that verified zero, followed by a birth.
//
// The activation transition does not close this on its own. It is a check the submitter passed BEFORE this
// cancellation existed; it does not ask again, and revoking its row afterwards changes nothing it will read.
//
// So the two pre-birth states get two different answers, and the difference is the whole point:
//
//   RESERVED — has not re-presented its proof yet. Revoke it: `activateWork` requires `state = 'reserved'`
//              and refuses, so this one can no longer be born.
//   ACTIVE   — has already been told yes. Nothing here can stop it, so the honest report is that this
//              teardown has NOT converged: the operation stays owed until the row leaves `active`.
//
// Rule `protocol` L5, exactly: completion is a read-back of zero, and "we could not find out" is an
// escalation rather than a terminal state.
//
// ── …AND AN AUTHORIZATION IS A LEASE (arch-review 59, the half c7b114b4 left open) ──────────────────
//
// "Stays owed until the row leaves `active`" has no liveness. A submitter that DIES between its activation
// and the submit never moves its row, so the operation is owed forever and escalates to an operator who can
// only look at a row nobody will ever move — an escalation that cannot resolve is a terminal state wearing a
// different word, which is the very thing the paragraph above refuses.
//
// It is decidable because the answer is already in hand: the handle was recorded at the RESERVATION, before
// any object existed, and the teardown killed and probed it on this pass — the `failures`/`live` check throws
// unless every one of them converged. So past the window, an aged submitter's external id has been verified
// absent by the same read-back that certifies every other unit, and waiting longer asks nobody a new
// question. Inside the window the probe is genuinely not authoritative, which is why the debt stays.
//
// Seen RED before the read-back existed, observed:
//   a cancellation certified zero while a dispatch was authorized to create work: promise resolved instead
//   of rejecting
//
// …and the lease seen RED in BOTH directions, which is the pair that matters — with no lease:
//   an abandoned activation was left able to act: expected 'active' to be 'revoked'
// …and with the lease ignored, revoking a submitter that may still be about to create its object:
//   a live submitter was revoked inside its own lease: expected true to be false

const NOW = "2026-08-21T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const WORK: RuntimeWorkRef = { tenant: "acme", runId: "evd-sc-ab-c1", externalJobId: "everdict-c1-aaaa" };

const record = (id: string) =>
  ({
    id,
    tenant: "acme",
    kind: "scorecard",
    status: "cancelled",
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1" },
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  }) as never;

// A batch whose only dispatch has reached `state`, and whose cluster says the work is not there — which is
// true, and is the answer that used to certify completion.
async function teardownWith(state: "reserved" | "active", opts: { activatedAgoMs?: number } = {}) {
  const store = new InMemoryScorecardStore();
  const runs = new InMemoryRunStore();
  runs.attachScorecards(store);
  const attempts = new InMemoryExecutionAttemptStore();
  const receipts = new InMemoryCaseReceiptStore();
  store.attachReceipts((id: string) => receipts.countFor(id));
  await store.create(record("sc-ab"));

  const opened = await attempts.open({
    executionId: storedExecutionId("evd-sc-ab-c1"),
    tenant: "acme",
    scorecardId: "sc-ab",
    caseId: "c1",
  } as never);
  await attempts.reserveWork(opened.attemptId, { ...WORK, attemptId: opened.attemptId });
  if (state === "active") await attempts.activateWork(opened.attemptId, { ...WORK, attemptId: opened.attemptId });
  // Age the activation by rewriting the row's clock — the same field the lease is measured from.
  if (opts.activatedAgoMs !== undefined) {
    const rows = await attempts.listForScorecard("sc-ab");
    const row = rows[0];
    if (row) Object.assign(row, { updatedAt: new Date(NOW_MS - opts.activatedAgoMs).toISOString() });
  }

  const service = new ScorecardService({
    dispatcher: {
      async dispatch(): Promise<CaseResult> {
        throw new Error("not under test");
      },
    },
    store,
    runStore: runs,
    caseReceipts: receipts,
    attempts,
    datasets: { get: async () => ({ id: "d", version: "1", cases: [], tags: [] }) },
    // The cluster is telling the truth: nothing was ever created under this handle.
    killWork: async (): Promise<KillOutcome> => ({ status: "absent" }),
    probeWork: async () => ({ kind: "absent" }),
    now: () => NOW,
  } as never);

  const outcome = await service
    .cancellationTeardown()("sc-ab")
    .then(() => ({ converged: true }))
    .catch((err: unknown) => ({ converged: false, why: String(err) }));
  const rows = await attempts.listForScorecard("sc-ab");
  return { outcome, rows };
}

describe("[R59 COUNTEREXAMPLE] a cancellation does not certify zero while a dispatch may still create work", () => {
  it("stays OWED when a dispatch is authorized and has not reported an object", async () => {
    const { outcome } = await teardownWith("active");
    expect(outcome.converged, "a cancellation certified zero while a dispatch was authorized to create work").toBe(
      false,
    );
    expect("why" in outcome ? outcome.why : "").toMatch(/authorized/i);
  });

  it("REVOKES an activation nobody came back for, and converges", async () => {
    // Past the lease. The container was never created — the cluster said so, on this pass, through the handle
    // the reservation recorded — so the row is taken back and the certificate may finally be written. Without
    // this the operation is owed for as long as the deployment lives.
    const { outcome, rows } = await teardownWith("active", { activatedAgoMs: ACTIVATION_LEASE_MS + 1_000 });
    expect(rows[0]?.state, "an abandoned activation was left able to act").toBe("revoked");
    expect(outcome.converged, "a cancellation stayed owed forever over a submitter that had died").toBe(true);
  });

  it("still stays OWED just INSIDE the lease", async () => {
    // The boundary in the safe direction: a submitter one second from creating its Job must not be revoked on
    // the strength of a probe that is not yet authoritative. That race is what the activation exists to close,
    // and buying liveness by reopening it would be worse than the defect.
    const { outcome } = await teardownWith("active", { activatedAgoMs: ACTIVATION_LEASE_MS - 1_000 });
    expect(outcome.converged, "a live submitter was revoked inside its own lease").toBe(false);
  });

  it("REVOKES a dispatch that has not re-presented its proof, and converges", async () => {
    // The other pre-birth state. Revoking is enough here because `activateWork` refuses anything that is not
    // `reserved` — so this one cannot be born, and the teardown may honestly finish.
    const { outcome, rows } = await teardownWith("reserved");
    expect(rows[0]?.state, "a reservation survived the cancellation and could still be activated").toBe("revoked");
    expect(outcome.converged, "the teardown stayed owed over work it had already made unbornable").toBe(true);
  });
});
