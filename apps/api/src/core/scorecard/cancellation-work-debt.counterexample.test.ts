import {
  InMemoryCaseReceiptStore,
  InMemoryExecutionAttemptStore,
  ScorecardService,
} from "@everdict/application-control";
import type { CaseResult, KillOutcome, RuntimeWorkRef, ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

// ── A DEBT OWNS ITS WORKLIST (arch-review 55, Wave 3) ────────────────────────────────────────────────
//
// The teardown enumerates the children that still read as `running`/`queued`, kills each one's exact work,
// and settles the row terminal — whether or not the kill converged. The first attempt collects the failure
// and keeps the operation owed, which is right. The RETRY iterates the same way:
//
//     for (const c of children) {
//       if (c.status !== "running" && c.status !== "queued") continue;
//
// …so every child the first pass terminalized is skipped. It finds nothing live, collects no failures, and
// CERTIFIES completion — over compute it never confirmed was gone. The method's own closing comment already
// named the shape of the hole: "no field claims the orchestrator was re-probed for the killed jobs
// afterwards."
//
// The debt evaporated because it was stored in the SUBJECT'S STATUS rather than in the operation. Row
// lifecycle and work lifecycle are different clocks: a row goes terminal because this process decided it
// should, and a container exits because a cluster acted. Only the second frees anything.
//
// INTERLEAVED BY CONSTRUCTION, and it has to be: attempt one is CORRECT, so a single-pass test sees nothing.
// The defect is what attempt one leaves behind for attempt two.

const record = (id: string): ScorecardRecord =>
  ({
    id,
    tenant: "acme",
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1" },
    status: "cancelled",
    runtime: "rt-1",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  }) as ScorecardRecord;

const WORK: RuntimeWorkRef = { tenant: "acme", runId: "evd-sc-wd-c1", externalJobId: "everdict-c1-aaaa" };

// A world whose cluster refuses the first stop and answers the second. The reconciler drives the teardown
// twice over it, which is exactly the sequence the operation's `owed` state exists to produce.
async function twoAttempts(
  outcomes: KillOutcome[],
  // A ledger that cannot be listed — the third answer `placedWork` has, and the one a teardown may never
  // round down to an empty workset (arch-review 55, Wave 3).
  opts?: { unreadableLedger?: boolean },
): Promise<{ killed: string[]; second: unknown; first: unknown }> {
  const store = new InMemoryScorecardStore();
  const receipts = new InMemoryCaseReceiptStore();
  store.attachReceipts((id) => receipts.countFor(id));
  const runs = new InMemoryRunStore();
  runs.attachScorecards(store);
  const attempts = new InMemoryExecutionAttemptStore();
  const killed: string[] = [];
  let call = 0;

  const rec = record("sc-wd");
  await store.create(rec);
  await runs.create({
    id: "child-1",
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: "c1",
    status: "running",
    parentScorecardId: "sc-wd",
    runtime: "rt-1",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  } as never);
  // The LEDGER of what this batch placed — the list a debt should be built from. It does not change when a
  // child row is settled, which is the whole point.
  const opened = await attempts.open({
    executionId: "evd-sc-wd-c1",
    tenant: "acme",
    scorecardId: "sc-wd",
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
    killWork: async (_tenant: string, _runtime: string | undefined, work: RuntimeWorkRef): Promise<KillOutcome> => {
      killed.push(work.externalJobId);
      return outcomes[call++] ?? { status: "absent" };
    },
  } as never);

  if (opts?.unreadableLedger === true)
    attempts.listForScorecard = async (): Promise<never> => {
      throw new Error("attempt ledger unreachable");
    };

  const teardown = service.cancellationTeardown();
  // ── ATTEMPT ONE: the cluster refuses. The operation stays owed (the teardown throws). ─────────────
  const first = await teardown("sc-wd").catch((err: unknown) => ({ threw: String(err) }));
  // ── ATTEMPT TWO: what the reconciler does next, against the world attempt one left. ───────────────
  const second = await teardown("sc-wd").catch((err: unknown) => ({ threw: String(err) }));
  return { killed, second, first };
}

// RED as of 898fc25f, observed: `expected [ 'everdict-c1-aaaa' ] to have a length of 2` — the second attempt
// never asked the cluster anything, because the child it would have asked about was terminal.
describe("[R55 WAVE-3 COUNTEREXAMPLE #3 — CLOSED] a cancellation retry re-kills what the first attempt could not stop", () => {
  it("asks the cluster again about the exact work whose kill failed", async () => {
    const { killed } = await twoAttempts([{ status: "unknown", reason: "cluster unreachable" }, { status: "absent" }]);
    expect(
      killed,
      "the retry skipped the handle because the child row it belonged to was terminal — the debt lived in the row, not in the operation",
    ).toHaveLength(2);
    expect(killed[1]).toBe(WORK.externalJobId);
  });

  it("does not certify completion on a pass that asked the cluster nothing", async () => {
    // Both attempts fail. The second must not converge just because there is no longer a live-looking child
    // to iterate — nothing has observed the work absent.
    const { second } = await twoAttempts([
      { status: "unknown", reason: "cluster unreachable" },
      { status: "unknown", reason: "cluster unreachable" },
    ]);
    expect(
      second,
      "a teardown that stopped nothing and asked nothing certified that the batch's compute was gone",
    ).toHaveProperty("threw");
  });

  // ── …AND A WORKSET IT COULD NOT ENUMERATE IS NOT AN EMPTY ONE ───────────────────────────────────
  //
  // The third answer, and the one `pnpm protocol-mutations` found untested: the two cases above both read the
  // ledger successfully, so neutralising the `unknown` arm left them green. A teardown whose ledger read
  // FAILED knows nothing about what this batch placed — rounding that to zero handles is the same collapse
  // one plane over, and it certifies completion over compute nobody ever enumerated, let alone stopped.
  it("refuses to build a workset from a ledger it could not read", async () => {
    const { first, killed } = await twoAttempts([{ status: "absent" }], { unreadableLedger: true });
    expect(killed, "the teardown killed handles it derived from a ledger read that failed").toEqual([]);
    expect(first, "a teardown that could not list its work reported the batch's compute as torn down").toHaveProperty(
      "threw",
    );
    expect(String((first as { threw: string }).threw)).toMatch(/cannot enumerate what it placed/);
  });
});
