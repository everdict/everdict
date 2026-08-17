import { soloReplicas } from "@everdict/application-control";
import type { RunRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it, vi } from "vitest";
import { runStartupRecovery } from "./runtime-access.js";

const runRec = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id,
  tenant: "acme",
  harness: { id: "h", version: "1" },
  caseId: "c1",
  status: "running",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("runStartupRecovery (the composition's background resume leg)", () => {
  it("tombstones a claimed run whose background adopt AND resume both fail — a claim is binding", async () => {
    // Regression: the background leg used to swallow a failed resume (`catch(() => {})`), leaving the
    // claimed record `running` forever — the exact zombie the boot recovery exists to prevent.
    const store = new InMemoryRunStore();
    const scorecardStore = new InMemoryScorecardStore();
    await store.create(runRec("unresumable"));

    await runStartupRecovery({
      scorecardStore,
      store,
      scorecardService: { resume: async () => false },
      service: { resume: async () => ({ kind: "unresumable" }) }, // no caseSpec to re-dispatch
      adoptWorkFn: async () => ({ established: true }), // no backend job survived to adopt
      owner: "cp-test",
      replicas: soloReplicas, // single process — every in-flight record is an orphan
    });

    await vi.waitFor(async () => {
      const record = await store.get("unresumable");
      expect(record?.status).toBe("failed");
      expect(record?.error?.code).toBe("INTERRUPTED");
    });
  });

  it("leaves a successfully resumed run alone — the resume path drives its status from here", async () => {
    const store = new InMemoryRunStore();
    const scorecardStore = new InMemoryScorecardStore();
    await store.create(runRec("resumable"));
    let resumed = false;

    await runStartupRecovery({
      scorecardStore,
      store,
      scorecardService: { resume: async () => false },
      service: {
        resume: async () => {
          resumed = true;
          return { kind: "resumed" };
        },
      },
      adoptWorkFn: async () => ({ established: true }),
      owner: "cp-test",
      replicas: soloReplicas,
    });

    await vi.waitFor(() => expect(resumed).toBe(true));
    expect((await store.get("resumable"))?.status).toBe("running");
  });

  it("NEVER tombstones a run that settled while the background leg was adopting it", async () => {
    // Arch-review 31 P0 — the whole reason `resume` stopped answering `boolean`.
    //
    // Adopting waits for the still-alive backend job to finish, which is the ORDINARY case, not an exotic
    // race: while this leg waits, the worker that was running the case reports its result and the row settles
    // `succeeded`. `resume` then loses its terminal CAS and can only say "not resumed" — which the old
    // composition read as "unresumable" and answered with a RAW, unfenced `failed{INTERRUPTED}` write.
    //
    // A successful evaluation was recorded in history as an infrastructure failure. Both halves are asserted
    // here: the service reports WHICH outcome this was, and the row still says succeeded.
    const store = new InMemoryRunStore();
    const scorecardStore = new InMemoryScorecardStore();
    await store.create(runRec("finished-mid-adopt"));

    await runStartupRecovery({
      scorecardStore,
      store,
      scorecardService: { resume: async () => false },
      service: {
        resume: async () => {
          // the worker's own settle lands first — exactly what the adopt was waiting for
          await store.update("finished-mid-adopt", { status: "succeeded", updatedAt: "2026-08-01T00:01:00.000Z" });
          return { kind: "already_settled", record: runRec("finished-mid-adopt", { status: "succeeded" }) };
        },
      },
      adoptWorkFn: async () => ({ established: true }),
      owner: "cp-test",
      replicas: soloReplicas,
    });

    // Give the background leg every chance to write the tombstone it used to write.
    await vi.waitFor(async () => expect((await store.get("finished-mid-adopt"))?.status).toBe("succeeded"));
    await new Promise((r) => setTimeout(r, 20));
    const record = await store.get("finished-mid-adopt");
    expect(record?.status).toBe("succeeded");
    expect(record?.error).toBeUndefined();
  });
});
