import { CampaignService, type CampaignSnapshot, RunService } from "@everdict/application-control";
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
    { id: "c1", heldOut: true },
    { id: "c2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  significance: {},
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  observationPolicy: { allowDivergent: false },
};

function build(snapshot: CampaignSnapshot) {
  const store = new InMemoryEvolutionCampaignStore();
  const campaignService = new CampaignService({
    store,
    operations: store,
    issues: {
      async get(_t: string, ref: string) {
        if (ref !== "iss_1") throw new NotFoundError("NOT_FOUND", { ref }, "issue not found");
        return { id: "iss_1" };
      },
    },
    diffs: { diffSnapshot: async () => snapshot },
    newId: () => "evc_fixed",
    now: () => "2026-08-26T03:00:00.000Z",
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    campaignService,
  });
  return { app, store };
}

const winning: CampaignSnapshot = {
  diff: {
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
        {
          caseId: "c2",
          baselineRate: 0.2,
          baselineTrials: 5,
          candidateRate: 0.2,
          candidateTrials: 5,
          delta: 0,
          z: 0,
          method: "fisher",
          p: 1,
          significant: false,
        },
      ],
    } as NonNullable<CampaignSnapshot["diff"]["trials"]>,
    experiment: { held: ["execution_world"], confounds: [], unverified: [] },
  },
  baseline: { record: { harness: { id: "agent:everdict", version: "1.0.0" } } },
  // The candidate side SEALS A MANIFEST, because a real batch does. A fixture without one runs the
  // label-only path, which the gate refuses without a frame waiver — so a suite built on one is not
  // exercising an ordinary adoption at all (arch-review 73).
  candidate: {
    record: {
      harness: { id: "agent:everdict", version: "1.0.1" },
      manifest: { harness: { specDigest: "sha256:cand-1.0.1" } },
    },
  },
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

  // ── THE AUTHORIZATION IS REACHABLE FROM A TRANSPORT (arch-review 73) ──────────────────────────────
  //
  // arch-review 71 wrote the durable operation and called `decided` "visible, addressable, re-drivable".
  // Nothing in apps/api called `forCampaign`, so it was none of the three: an adopted campaign left an
  // authorization no caller could read, and therefore none could present it either. That is this repo's own
  // comment-is-a-claim law — the half implemented is the WRITE, the half written down is the recovery.
  //
  // Seen RED before the route existed, observed:
  //   the authorization a settled campaign wrote is unreachable: expected 404 to be 200
  it("exposes what an adopted close AUTHORIZED, and says plainly when a campaign authorized nothing", async () => {
    const { app } = build(winning);
    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame },
    });
    const { id } = opened.json() as { id: string };

    // Before any settle there is nothing to spend — an ANSWER, not a 404 that reads as "no such campaign".
    const beforeRes = await app.inject({ method: "GET", url: `/campaigns/${id}/adoption`, headers: H });
    expect(beforeRes.statusCode).toBe(200);
    const before = beforeRes.json() as { state: string; operation: unknown };
    expect(before.state).toBe("open");
    expect(before.operation).toBeNull();

    await app.inject({
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
    expect((await app.inject({ method: "POST", url: `/campaigns/${id}/settle`, headers: H })).statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: `/campaigns/${id}/adoption`, headers: H });
    expect(res.statusCode, "the authorization a settled campaign wrote is unreachable").toBe(200);
    const body = res.json() as {
      state: string;
      operation: {
        state: string;
        proof: { candidate: { identity: string; version: string; specDigest?: string }; issueId: string };
      } | null;
    };
    expect(body.state).toBe("adopted");
    // `decided` — the state a settle-then-crash lands in, and the one a registry write spends.
    expect(body.operation?.state, "an adopted campaign authorized nothing anybody could spend").toBe("decided");
    expect(body.operation?.proof.candidate.version).toBe("1.0.1");
    expect(body.operation?.proof.candidate.identity).toBe("exact");
    expect(body.operation?.proof.candidate.specDigest).toBe("sha256:cand-1.0.1");
    expect(body.operation?.proof.issueId, "the decision and its intent came apart").toBe("iss_1");
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
    // A COMPLETE body that also smuggles a verdict: the schema strips the field and the logged round's
    // verdict is the DERIVED one — the loop cannot write its own report card (Track D, L3).
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
      payload: {
        hypothesis: "h",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
        verdict: { comparable: true, significantImprovements: 99, significantRegressions: 0 },
      },
    });
    expect(smuggled.statusCode).toBe(201);
    const loggedVerdict = (smuggled.json() as { round: { verdict: { significantImprovements: number } } }).round
      .verdict;
    expect(loggedVerdict.significantImprovements).toBe(1); // the diff's answer, not the smuggled 99
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
