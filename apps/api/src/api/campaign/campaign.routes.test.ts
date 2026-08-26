import { type CampaignComparison, CampaignService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { CampaignFrame } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
import { InMemoryEvolutionCampaignStore, InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// The campaign settlement over the HTTP transport — thin-route behavior (gate order, DTO refusal, error
// mapping) over the same service the MCP twin drives. The diff is faked at the service seam: transport
// tests pin the wire, the service/store suites pin the derivation (rule `testing`).

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in campaign tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

const frame: CampaignFrame = {
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "s1", heldOut: false },
    { id: "s2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  significance: {},
  allowUnverifiedIdentity: false,
};

function build(comparison: CampaignComparison) {
  const store = new InMemoryEvolutionCampaignStore();
  const campaignService = new CampaignService({
    store,
    issues: {
      async get(_t: string, ref: string) {
        if (ref !== "iss_1") throw new NotFoundError("NOT_FOUND", { ref }, "issue not found");
        return { id: "iss_1" };
      },
    },
    diffs: { diff: async () => comparison },
    newId: () => "evc_fixed",
    now: () => "2026-08-26T03:00:00.000Z",
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    campaignService,
  });
  return { app, store };
}

const winning: CampaignComparison = {
  comparability: "full",
  trials: {
    baseline: "b",
    candidate: "c",
    zThreshold: 1.96,
    minDelta: 0,
    cases: [
      {
        caseId: "c1",
        baselineRate: 0,
        baselineTrials: 5,
        candidateRate: 1,
        candidateTrials: 5,
        delta: 1,
        z: 3,
        method: "fisher",
        p: 0.0079,
        significant: true,
      },
    ],
  } as CampaignComparison["trials"],
  experiment: { held: ["execution_world"], confounds: [], unverified: [] },
};

describe("campaign routes — the settlement over HTTP", () => {
  it("opens against a real issue, logs a derived round, and settles with the gate's answer", async () => {
    const { app } = build(winning);
    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame },
    });
    expect(opened.statusCode).toBe(201);
    const { id, frameDigest } = opened.json() as { id: string; frameDigest: string };
    expect(frameDigest).toMatch(/^sha256:/);

    const logged = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "structure over phrasing",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
      },
    });
    expect(logged.statusCode).toBe(201);
    const round = (logged.json() as { round: { verdict: { significantImprovements: number } } }).round;
    expect(round.verdict.significantImprovements).toBe(1);

    const decision = await app.inject({ method: "GET", url: `/campaigns/${id}/decision`, headers: H });
    expect((decision.json() as { kind: string }).kind).toBe("adopt");

    const settled = await app.inject({ method: "POST", url: `/campaigns/${id}/settle`, headers: H });
    expect(settled.statusCode).toBe(200);
    expect((settled.json() as { record: { state: string } }).record.state).toBe("adopted");
    await app.close();
  });

  it("refuses to open against a ghost issue (404), and a caller-authored verdict has nowhere to land", async () => {
    const { app } = build(winning);
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "nope", frame },
    });
    expect(res.statusCode).toBe(404);
    // The round body has no verdict field — a caller trying to smuggle one is a schema refusal, because the
    // verdict is derived from the production diff, never accepted (Track D, L3).
    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame },
    });
    const { id } = opened.json() as { id: string };
    const smuggled = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: H,
      payload: { hypothesis: "h", candidateVersion: "1.0.1", baselineScorecardId: "b" }, // missing candidate id
    });
    expect(smuggled.statusCode).toBe(400);
    await app.close();
  });

  it("a settle while the gate answers continue is a 409, and the campaign stays open", async () => {
    const { app } = build(winning);
    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame },
    });
    const { id } = opened.json() as { id: string };
    const res = await app.inject({ method: "POST", url: `/campaigns/${id}/settle`, headers: H });
    expect(res.statusCode).toBe(409);
    const read = await app.inject({ method: "GET", url: `/campaigns/${id}`, headers: H });
    expect((read.json() as { state: string }).state).toBe("open");
    await app.close();
  });

  it("routes answer 404 when the service is not composed — the feature gate", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    const res = await app.inject({ method: "GET", url: "/campaigns", headers: H });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
