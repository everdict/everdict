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
      service: { resume: async () => false }, // no caseSpec to re-dispatch
      adoptCaseFn: async () => undefined, // no backend job survived to adopt
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
          return true;
        },
      },
      adoptCaseFn: async () => undefined,
    });

    await vi.waitFor(() => expect(resumed).toBe(true));
    expect((await store.get("resumable"))?.status).toBe("running");
  });
});
