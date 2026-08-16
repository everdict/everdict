import { InMemoryCancellationStore, InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { CaseResult, RunRecord, ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

// ── THE CANCELLATION PROTOCOL, NOT JUST THE ROW (arch-review 51 P0) ──────────────────────────────────
//
// Three halves of one contract, each of which used to be quietly weaker:
//  · the teardown is OWED by the same write that decides the abort (the operation row rides the settle —
//    a crash after the CANCELLED commit can no longer leave a decided abort nobody owns);
//  · COMPLETED means the postcondition was read back (no child still live), not "commands were issued"
//    (killCase was fire-and-forget; the operation completed over work that had not stopped);
//  · a batch whose teardown is still owed cannot be DELETED (the reconciler would close the operation as
//    unactionable while the live work it was owed for keeps burning).

function world(extraDeps: Record<string, unknown> = {}) {
  const store = new InMemoryScorecardStore();
  const receipts = new InMemoryCaseReceiptStore();
  store.attachReceipts((id) => receipts.countFor(id));
  const cancellations = new InMemoryCancellationStore();
  store.attachCancellations(
    (id) => void cancellations.request({ kind: "scorecard", id }, new Date().toISOString()).catch(() => {}),
  );
  const runs = new InMemoryRunStore();
  runs.attachScorecards(store);
  const service = new ScorecardService({
    dispatcher: {
      async dispatch(): Promise<CaseResult> {
        throw new Error("not under test");
      },
    },
    store,
    runStore: runs,
    caseReceipts: receipts,
    cancellations,
    datasets: { get: async () => ({ id: "d", version: "1", cases: [], tags: [] }) },
    ...extraDeps,
  } as never);
  return { store, runs, receipts, cancellations, service };
}

const record = (id: string, status: ScorecardRecord["status"] = "running"): ScorecardRecord =>
  ({
    id,
    tenant: "acme",
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1" },
    status,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  }) as ScorecardRecord;

const child = (id: string, scorecardId: string, status: RunRecord["status"] = "running"): RunRecord =>
  ({
    id,
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: `case-${id}`,
    status,
    parentScorecardId: scorecardId,
    trigger: "scorecard",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  }) as RunRecord;

describe("the abort settle owns its teardown (decision + operation, one write)", () => {
  it("the operation row exists the moment the CANCELLED settle commits — even when every API-level request fails", async () => {
    // The settle-time pair is the STORE's write (Postgres runs it inside the settle statement); the
    // API-level request is the old best-effort lane. Model exactly that split: the attach writes through
    // the store's internals, while the public request — the only thing the pre-pair code ever called —
    // always fails. A row appearing anyway proves it rode the settle.
    const store = new InMemoryScorecardStore();
    const receipts = new InMemoryCaseReceiptStore();
    store.attachReceipts((id) => receipts.countFor(id));
    const cancellations = new InMemoryCancellationStore();
    const settleTimeRequest = cancellations.request.bind(cancellations);
    store.attachCancellations((id) => void settleTimeRequest({ kind: "scorecard", id }, "2026-08-15T00:00:01.000Z"));
    // EVERY API-level write fails — request, fail AND complete all upsert, so leaving any of them alive
    // lets the post-hoc lane fabricate the row this test exists to prove rode the settle instead.
    cancellations.request = async () => {
      throw new Error("cancellation store API down");
    };
    cancellations.fail = async () => {
      throw new Error("cancellation store API down");
    };
    cancellations.complete = async () => {
      throw new Error("cancellation store API down");
    };
    const runs = new InMemoryRunStore();
    runs.attachScorecards(store);
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(): Promise<CaseResult> {
          throw new Error("not under test");
        },
      },
      store,
      runStore: runs,
      caseReceipts: receipts,
      cancellations,
      datasets: { get: async () => ({ id: "d", version: "1", cases: [], tags: [] }) },
    } as never);
    await store.create(record("sc-tx"));
    await service.cancel({ tenant: "acme", id: "sc-tx" });
    expect((await store.get("sc-tx"))?.status).toBe("cancelled");
    const operation = await cancellations.get({ kind: "scorecard", id: "sc-tx" });
    expect(operation?.state).toBe("requested"); // owed by the settle itself — the crash window is gone
  });

  it("a supersede's settle carries the same pair — the abort with no user-facing retry", async () => {
    const { store, cancellations } = world();
    await store.create(record("sc-sup"));
    // Drive the settle exactly as supersedeInFlight does: terminal patch + requestCancellation.
    const settled = await store.update(
      "sc-sup",
      { status: "superseded", updatedAt: "2026-08-15T00:00:01.000Z" },
      undefined,
      { expectNonTerminal: true, requestCancellation: true },
    );
    expect(settled?.status).toBe("superseded");
    expect((await cancellations.get({ kind: "scorecard", id: "sc-sup" }))?.state).toBe("requested");
  });

  it("a settle the fence refused owes nothing — no operation row for a write that did not happen", async () => {
    const { store, cancellations } = world();
    await store.create(record("sc-done", "succeeded"));
    const settled = await store.update("sc-done", { status: "cancelled" }, undefined, {
      expectNonTerminal: true,
      requestCancellation: true,
    });
    expect(settled).toBeUndefined();
    expect(await cancellations.get({ kind: "scorecard", id: "sc-done" })).toBeUndefined();
  });
});

describe("COMPLETED proves the postcondition, not the attempt", () => {
  it("a kill that fails keeps the operation owed — the cancel surfaces the failure instead of completing over live compute", async () => {
    const { store, runs, cancellations, service } = world({
      killCase: async () => {
        throw new Error("cluster unreachable");
      },
    });
    await store.create(record("sc-kill"));
    await runs.create(child("child-kill", "sc-kill"));
    await expect(service.cancel({ tenant: "acme", id: "sc-kill" })).rejects.toThrow(
      /not converged|cluster unreachable/,
    );
    expect((await store.get("sc-kill"))?.status).toBe("cancelled"); // the decision is durable…
    expect((await cancellations.get({ kind: "scorecard", id: "sc-kill" }))?.state).toBe("requested"); // …and the teardown stays owed
  });

  it("a child still live after the teardown loop keeps the operation owed — commands issued is not converged", async () => {
    const { store, runs, cancellations, service } = world();
    // The child's terminal settle is refused (store under duress) while the list still reports it running.
    const originalUpdate = runs.update.bind(runs);
    runs.update = async (...args: Parameters<typeof originalUpdate>) =>
      args[0] === "child-stuck" ? undefined : originalUpdate(...args);
    await store.create(record("sc-stuck"));
    await runs.create(child("child-stuck", "sc-stuck"));
    await expect(service.cancel({ tenant: "acme", id: "sc-stuck" })).rejects.toThrow(/not converged/);
    expect((await cancellations.get({ kind: "scorecard", id: "sc-stuck" }))?.state).toBe("requested");
  });

  it("a clean teardown completes the operation — the ordinary case still ends", async () => {
    const { store, runs, cancellations, service } = world();
    await store.create(record("sc-clean"));
    await runs.create(child("child-clean", "sc-clean"));
    await service.cancel({ tenant: "acme", id: "sc-clean" });
    expect((await runs.get("child-clean"))?.status).toBe("failed");
    expect((await cancellations.get({ kind: "scorecard", id: "sc-clean" }))?.state).toBe("completed");
  });
});

describe("delete refuses while the teardown is owed", () => {
  const admin = { subject: "root", workspace: "acme", roles: ["admin"], via: "test" } as never;

  it("an incomplete cancellation refuses the delete — erasing the rows would orphan the live work", async () => {
    const { store, cancellations, service } = world();
    await store.create(record("sc-del", "cancelled"));
    await cancellations.request({ kind: "scorecard", id: "sc-del" }, "2026-08-15T00:00:02.000Z");
    await expect(service.delete({ principal: admin, id: "sc-del" })).rejects.toThrow(/teardown has not finished/);
    expect(await store.get("sc-del")).toBeDefined();
  });

  it("a completed cancellation deletes normally", async () => {
    const { store, cancellations, service } = world();
    await store.create(record("sc-del-ok", "cancelled"));
    await cancellations.request({ kind: "scorecard", id: "sc-del-ok" }, "2026-08-15T00:00:02.000Z");
    await cancellations.complete({ kind: "scorecard", id: "sc-del-ok" }, "2026-08-15T00:00:03.000Z");
    await service.delete({ principal: admin, id: "sc-del-ok" });
    expect(await store.get("sc-del-ok")).toBeUndefined();
  });
});

describe("the legacy gap sweep hands unowned teardowns to the reconciler", () => {
  it("an aborted batch with live children and no operation row gets one; settled aborts are left alone", async () => {
    const { store, runs, cancellations, service } = world();
    // The legacy shape: cancelled before the settle carried the pair — no operation row exists.
    await store.create(record("sc-gap", "cancelled"));
    await runs.create(child("child-gap", "sc-gap"));
    await store.create(record("sc-quiet", "cancelled")); // aborted, but nothing live — nothing owed
    const requested = await service.sweepAbortedTeardownGaps();
    expect(requested).toBe(1);
    expect((await cancellations.get({ kind: "scorecard", id: "sc-gap" }))?.state).toBe("requested");
    expect(await cancellations.get({ kind: "scorecard", id: "sc-quiet" })).toBeUndefined();
  });
});
