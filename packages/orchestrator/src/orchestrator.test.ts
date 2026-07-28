import { createServer } from "node:http";
import { BackendRegistry, Router } from "@everdict/backends";
import type { Backend } from "@everdict/backends";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { createActivities } from "./activities.js";
import { DirectOrchestrator } from "./orchestrator.js";

class FakeBackend implements Backend {
  constructor(readonly id: string) {}
  async capacity() {
    return { total: 1, used: 0 };
  }
  async dispatch(_job: CaseJob): Promise<CaseResult> {
    return {
      caseId: "c",
      harness: this.id,
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [],
    };
  }
}

const job: CaseJob = {
  harness: { id: "scripted", version: "0" },
  evalCase: { id: "c", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
};

const router = new Router(new BackendRegistry().register("x", new FakeBackend("x")), "x");

describe("DirectOrchestrator", () => {
  it("runs a job via the Router", async () => {
    expect((await new DirectOrchestrator(router).run(job)).harness).toBe("x");
  });
});

describe("createActivities", () => {
  it("dispatchCase calls the Router (the activity the worker registers)", async () => {
    const acts = createActivities(router);
    expect((await acts.dispatchCase(job)).harness).toBe("x");
  });
});

// B3 — the internal-bridge activities own their undici dispatcher: the batch-case call holds ONE response open
// while the control plane executes+settles a whole eval case, and the global fetch's 300s headersTimeout used to
// cut it — every >5-minute case failed identically and the scorecard came back empty.
describe("createActivities — internal-bridge response ceiling (own dispatcher)", () => {
  async function slowServer(delayMs: number): Promise<{ base: string; close: () => Promise<void> }> {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ settled: true }));
      }, delayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = addr !== null && typeof addr === "object" ? addr.port : 0;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("a generous ceiling lets a long-held batch-case response settle; a small one cuts it", async () => {
    // 1.6s hold — beyond a 500ms ceiling but far below the generous one (undici timers have ~1s granularity).
    const srv = await slowServer(1600);
    try {
      const generous = createActivities(router, { apiUrl: srv.base, internalToken: "t", headersTimeoutMs: 30_000 });
      await expect(generous.runBatchCase({ scorecardId: "s", caseId: "c" })).resolves.toEqual({ settled: true });
      const strict = createActivities(router, { apiUrl: srv.base, internalToken: "t", headersTimeoutMs: 500 });
      await expect(strict.runBatchCase({ scorecardId: "s", caseId: "c" })).rejects.toThrow();
    } finally {
      await srv.close();
    }
  }, 20_000);
});
