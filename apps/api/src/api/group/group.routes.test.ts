import { RunService, ScorecardService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const H = { "x-everdict-tenant": "acme" };

// Phase 1 only — every dispatched case "runs" and reports nothing scored (the ungraded contract).
const okDispatch: Dispatcher = {
  async dispatch(job) {
    return {
      caseId: job.evalCase.id,
      harness: `${job.harness.id}@${job.harness.version}`,
      trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } }],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [],
    };
  },
};

function build() {
  const store = new InMemoryScorecardStore();
  const app = buildServer({
    service: new RunService({ dispatcher: okDispatch, store: new InMemoryRunStore() }),
    scorecardService: new ScorecardService({ dispatcher: okDispatch, store, datasets: new InMemoryDatasetRegistry() }),
  });
  return { app, store };
}

describe("run groups (/groups — P1 experiments)", () => {
  it("submits an ad-hoc task experiment (202, kind experiment, _adhoc sentinel) and reads it back via /groups/:id", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: H,
      payload: { harness: { id: "scripted", version: "0" }, task: { prompt: "say hi" }, trials: 2 },
    });
    expect(res.statusCode).toBe(202);
    const record = res.json();
    expect(record.kind).toBe("experiment");
    expect(record.dataset).toEqual({ id: "_adhoc", version: "adhoc" });

    const got = await app.inject({ method: "GET", url: `/groups/${record.id}`, headers: H });
    expect(got.statusCode).toBe(200);
    expect(got.json().id).toBe(record.id);
    // One table (O3): the same record also reads through the scorecard surface.
    const viaScorecards = await app.inject({ method: "GET", url: `/scorecards/${record.id}`, headers: H });
    expect(viaScorecards.statusCode).toBe(200);
    expect(viaScorecards.json().kind).toBe("experiment");
  });

  it("rejects a body with both dataset and task (exactly-one contract) with 400", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: H,
      payload: {
        harness: { id: "scripted", version: "0" },
        dataset: { id: "d", version: "1.0.0" },
        task: { prompt: "hi" },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("another workspace's group reads 404 (no existence leak)", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: H,
      payload: { harness: { id: "scripted", version: "0" }, task: { prompt: "say hi" } },
    });
    expect(res.statusCode).toBe(202);
    const got = await app.inject({
      method: "GET",
      url: `/groups/${res.json().id}`,
      headers: { "x-everdict-tenant": "rival" },
    });
    expect(got.statusCode).toBe(404);
  });
});
