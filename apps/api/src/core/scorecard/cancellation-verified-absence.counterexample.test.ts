import {
  InMemoryCaseReceiptStore,
  InMemoryExecutionAttemptStore,
  ScorecardService,
} from "@everdict/application-control";
import type { CaseResult, KillOutcome, RuntimeWorkRef, ScorecardRecord, WorkPresence } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

// ── "THE DELETE WAS ACCEPTED" IS NOT "THE COMPUTE IS GONE" (arch-review 56, Wave G) ──────────────────
//
// L5's first sentence, and the last place in the cancellation path that still trusted a command's answer
// instead of a read. `KillOutcome` distinguishes four answers and the teardown converges on two of them:
//
//     stopped | absent  → converged
//     unknown | failed  → the operation stays owed
//
// `absent` is a READ — the sweep looked and there was nothing. `stopped` is not: the Kubernetes lane deletes
// with `--wait=false`, which returns as soon as the API server accepts the request, and Nomad's stop returns
// once the job is marked for stopping. Between that and the container actually exiting there is a graceful
// termination period, an image-pull to interrupt, a finalizer to run — during which the certificate says the
// batch's compute is gone and the batch's compute is running and billing.
//
// The gap is not exotic: it is the ordinary shape of every managed delete. It just never showed, because the
// only thing that ever looked was the CHILD ROW, and the teardown terminalizes those itself.
//
// So a stop that answered `stopped` is followed by a PROBE of the exact same handle, and only an observed
// absence converges it. `WorkPresence` is deliberately its own three-valued answer rather than the display
// projection `inspectWork` returns: that one reports `queued` for a K8s Job with no pods yet, which is
// indistinguishable from a Job that is gone — a phase, where this needs existence.

const record = (id: string): ScorecardRecord =>
  ({
    id,
    tenant: "acme",
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1" },
    status: "cancelled",
    runtime: "rt-1",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  }) as ScorecardRecord;

const WORK: RuntimeWorkRef = { tenant: "acme", runId: "evd-sc-vz-c1", externalJobId: "everdict-c1-aaaa" };

// A world whose cluster ACCEPTS the delete and whose object is still there afterwards — the graceful-shutdown
// window, which is what `--wait=false` returns in the middle of.
async function tearDown(opts: {
  kill: KillOutcome;
  presence?: WorkPresence;
}): Promise<{ probed: string[]; outcome: unknown }> {
  const store = new InMemoryScorecardStore();
  const receipts = new InMemoryCaseReceiptStore();
  store.attachReceipts((id) => receipts.countFor(id));
  const runs = new InMemoryRunStore();
  runs.attachScorecards(store);
  const attempts = new InMemoryExecutionAttemptStore();
  const probed: string[] = [];

  await store.create(record("sc-vz"));
  await runs.create({
    id: "child-1",
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: "c1",
    status: "running",
    parentScorecardId: "sc-vz",
    runtime: "rt-1",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  } as never);
  const opened = await attempts.open({
    executionId: "evd-sc-vz-c1",
    tenant: "acme",
    scorecardId: "sc-vz",
    caseId: "c1",
    childRunId: "child-1",
  } as never);
  await attempts.reserveWork(opened.attemptId, { ...WORK, attemptId: opened.attemptId });

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
    killWork: async (): Promise<KillOutcome> => opts.kill,
    probeWork: async (_t: string, _r: string | undefined, work: RuntimeWorkRef): Promise<WorkPresence> => {
      probed.push(work.externalJobId);
      return opts.presence ?? { kind: "absent" };
    },
  } as never);

  const outcome = await service
    .cancellationTeardown()("sc-vz")
    .catch((err: unknown) => ({ threw: String(err) }));
  return { probed, outcome };
}

// RED as of 3dc02bd9, observed:
//   a stop that was merely ACCEPTED converged the cancellation: expected [] to have a length of 1
describe("[R56 WAVE-G COUNTEREXAMPLE #8 — CLOSED] a cancellation converges on an observed absence", () => {
  it("probes the exact handle after a stop that was only accepted", async () => {
    const { probed } = await tearDown({ kill: { status: "stopped" } });
    expect(
      probed,
      "a stop that was merely ACCEPTED converged the cancellation — nothing looked at whether the object went away",
    ).toEqual([WORK.externalJobId]);
  });

  it("stays owed while the object is still there", async () => {
    // The graceful-termination window: the delete was accepted and the container is still running. A
    // certificate written here says the batch's compute is gone while it is still burning.
    const { outcome } = await tearDown({ kill: { status: "stopped" }, presence: { kind: "live" } });
    expect(outcome, "the teardown certified completion over work it had just seen alive").toHaveProperty("threw");
  });

  it("stays owed when the probe could not find out — that is not an absence", async () => {
    const { outcome } = await tearDown({
      kill: { status: "stopped" },
      presence: { kind: "unknown", reason: "cluster unreachable" },
    });
    expect(outcome).toHaveProperty("threw");
  });

  it("does not re-probe a kill that already ANSWERED absent — that answer is the read", async () => {
    // The other direction, and why this is a probe of `stopped` rather than of everything: `absent` already
    // means the sweep looked and found nothing. Probing again would double every teardown's cluster calls to
    // re-learn what the kill just told us.
    const { probed, outcome } = await tearDown({ kill: { status: "absent" } });
    expect(probed).toEqual([]);
    expect(outcome).not.toHaveProperty("threw");
  });
});
