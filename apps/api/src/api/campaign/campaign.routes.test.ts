import { CampaignService, type CampaignSnapshot, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { CampaignFrame } from "@everdict/contracts";
import { AgentSpecSchema } from "@everdict/contracts";
import { NotFoundError, readUnknown } from "@everdict/contracts";
import { InMemoryEvolutionCampaignStore, InMemoryRunStore } from "@everdict/db";
import { InMemoryCampaignEvidenceStore } from "@everdict/db";
import { contentDigest } from "@everdict/domain";
import { InMemoryAgentRegistry, InMemoryEnvironmentRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildCampaignAdoption } from "../../composition/campaign-adoption.js";
import { buildServer } from "../../server.js";

// The two reads a campaign service now REQUIRES and these cases do not exercise: a pull-request listing (the
// frame's oracle scope) and a delegation session (the frame's delegation budget). Stated as unavailable rather
// than omitted — an optional dep would let "not wired" read as "clean" (rule `protocol`).
const noChanges = {
  pullRequestFiles: async () =>
    readUnknown<{ paths: string[]; complete: boolean }>("no pull-request reader in this fixture"),
};
const noRuns = { get: async () => undefined };
const noDatasets = {
  get: async (): Promise<never> => {
    throw new NotFoundError("NOT_FOUND", {}, "no dataset registry in this fixture");
  },
};
// A harness with no seeds: the leak check reads "nothing to check", never "clean by default".
const noSeedProvenance = {
  seedsOf: async () => ({ kind: "read" as const, value: undefined }),
  evidenceOf: async () => ({ kind: "read" as const, value: [] }),
};
// A single-slot harness: attribution by construction, so these cases test what they are about.
const noShape = { slotsOf: async () => ({ kind: "read" as const, value: [{ slot: "image", tools: [] }] }) };

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
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 }, // frozen: the level, and the family it is corrected over
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  oracleScope: [],
  targets: [],
  observationPolicy: { allowDivergent: false },
};

function build(snapshot: CampaignSnapshot) {
  const store = new InMemoryEvolutionCampaignStore();
  const campaignService = new CampaignService({
    // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
    // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
    scorecards: { get: async () => undefined },
    store,
    operations: store,
    changes: noChanges,
    runs: noRuns,
    datasets: noDatasets,
    seedProvenance: noSeedProvenance,
    shape: noShape,
    evidence: new InMemoryCampaignEvidenceStore(),
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
  // …and the CONSUMER of what a settle authorizes, wired through the production builder — not a hand-made
  // deps bag. A route test that stubbed the service would prove the route calls something (arch-review 72's
  // defect exactly), so this uses `buildCampaignAdoption` over a real registry.
  const agents = new InMemoryAgentRegistry();
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    campaignService,
    // Opening a campaign resolves the issue's TEAM, so the tracker is a REQUIRED dependency of that route
    // now (arch-review 79: an optional call there deleted the whole team check). These cases run with no
    // teams configured, which is the unowned shape — the workspace's, writable by every member.
    issueService: {
      async get(_t: string, ref: string) {
        return ref === "iss_1" ? { id: "iss_1" } : undefined;
      },
    } as unknown as NonNullable<Parameters<typeof buildServer>[0]["issueService"]>,
    // The SAME registry the adoption writes through — a fixture whose registry differs from the one under
    // test proves nothing about what the adoption registered.
    agentRegistry: agents,
    campaignAdoption: buildCampaignAdoption({
      operations: store,
      agents,
      harnesses: unusedHarnesses(),
      templates: unusedTemplates(),
      environments: new InMemoryEnvironmentRegistry(),
      issues: openIssue(),
    }),
  });
  return { app, store, agents };
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
        learned: "the shorter instructions cut tool calls but the win sat on training rows only",
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

  // ── [COUNTEREXAMPLE] A ROUND THAT COMPARED THE SUBJECT WITH ITSELF IS NOT A ROUND ────────────────
  //
  // Found by driving a real campaign end to end. A candidate authored with a plausible-but-wrong override key
  // registers the TEMPLATE'S OWN BYTES under a new version label (the registry refuses that spelling now, and
  // cannot see a candidate that is identical for any other reason). Left comparable, such a round is the
  // worst-shaped evidence this record can hold: 0 improvements, 0 regressions — which the driver is told to
  // read as a NEUTRAL result and build on — while a slot of the pre-registered held-out family is spent and
  // the consecutive-rejection counter moves. The direction was never tried.
  //
  // Observed RED before the guard: `expected 'both sides ran the same harness bytes…' to be undefined`, i.e.
  // the round came back comparable with a neutral verdict.
  it("REFUSES a harness round whose two sides ran the same bytes — a relabelled baseline is not a candidate", async () => {
    const sameBytes = {
      ...winning,
      baseline: {
        record: {
          harness: { id: "patchbot", version: "1.0.0" },
          manifest: { harness: { specDigest: "sha256:identical" } },
        },
      },
      candidate: {
        record: {
          harness: { id: "patchbot", version: "1.0.1" },
          manifest: { harness: { specDigest: "sha256:identical" } },
        },
      },
    };
    const { app } = build(sameBytes as typeof winning);
    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: {
        issueId: "iss_1",
        frame: { ...frame, subject: { type: "harness", id: "patchbot", baselineVersion: "1.0.0" } },
      },
    });
    const { id } = opened.json() as { id: string };
    const logged = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "the override never reached the spec, so this 'candidate' is the baseline",
        learned: "a round with no treatment must not be recorded as a neutral finding about a direction",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
      },
    });
    expect(logged.statusCode).toBe(201);
    const verdict = (logged.json() as { round: { verdict: { comparable: boolean; detail?: string } } }).round.verdict;
    expect(verdict.comparable).toBe(false);
    expect(verdict.detail).toContain("the same harness bytes");
    await app.close();
  });

  // …and the mirror: an ENVIRONMENT campaign REQUIRES the harness to be identical on both sides — that is what
  // isolates the world as the treatment — so the same equality must not be refused there.
  it("allows an ENVIRONMENT round with identical harness bytes — there the equality is the precondition", async () => {
    // The world moved and the actor did not: same harness id, same version, same BYTES, and each side's
    // manifest seals a different version of the environment under test.
    const worldMoved = {
      ...winning,
      baseline: {
        record: {
          harness: { id: "patchbot", version: "1.0.0" },
          manifest: {
            harness: { specDigest: "sha256:identical" },
            environments: { c1: { ref: "shop@1.0.0" }, c2: { ref: "shop@1.0.0" } },
          },
        },
      },
      candidate: {
        record: {
          harness: { id: "patchbot", version: "1.0.0" },
          manifest: {
            harness: { specDigest: "sha256:identical" },
            environments: { c1: { ref: "shop@1.1.0" }, c2: { ref: "shop@1.1.0" } },
          },
        },
      },
    };
    const { app } = build(worldMoved as typeof winning);
    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: {
        issueId: "iss_1",
        frame: { ...frame, subject: { type: "environment", id: "shop", baselineVersion: "1.0.0" } },
      },
    });
    const { id } = opened.json() as { id: string };
    const logged = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "the world moved; the agent did not",
        learned: "an environment campaign holds the harness still on purpose, so identical bytes are expected",
        candidateVersion: "1.1.0",
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
      },
    });
    expect(logged.statusCode).toBe(201);
    const verdict = (logged.json() as { round: { verdict: { comparable: boolean } } }).round.verdict;
    expect(verdict.comparable, "the harness being equal is what makes the world the treatment").toBe(true);
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
        learned: "the shorter instructions cut tool calls but the win sat on training rows only",
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

  // ── AND THE AUTHORIZATION IS SPENDABLE, ONCE (arch-review 72 P0 / 73) ─────────────────────────────
  //
  // The whole protocol over the real transport: settle writes an authorization, the read surface returns it,
  // and the adopt route spends it on a registry write whose bytes are checked against what was measured.
  // arch-review 72 built the service that does this and no code path reached it; this is that path.
  //
  // Seen RED before the route existed, observed:
  //   the authorization cannot be spent from any transport: expected 404 to be 200
  it("settles, exposes the authorization, and SPENDS it on a registry write — once", async () => {
    // The digest the campaign seals is what the REGISTRY resolves for this version, so the round's manifest
    // and the adopt read-back are about ONE document. Building the fixture the other way round — a
    // hand-written digest string — would make the honest path unreachable and leave only refusals tested.
    const spec = AgentSpecSchema.parse({ id: "everdict", version: "1.0.1", instructions: "structure first" });
    const seeded = new InMemoryAgentRegistry();
    await seeded.register("acme", spec, "alice");
    const measured = contentDigest(await seeded.get("acme", "everdict", "1.0.1"));
    const { app, agents } = build({
      ...winning,
      candidate: { record: { ...winning.candidate.record, manifest: { harness: { specDigest: measured } } } },
    });

    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame },
    });
    const { id } = opened.json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "structure over phrasing",
        learned: "the shorter instructions cut tool calls but the win sat on training rows only",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
      },
    });
    expect((await app.inject({ method: "POST", url: `/campaigns/${id}/settle`, headers: H })).statusCode).toBe(200);

    const read = await app.inject({ method: "GET", url: `/campaigns/${id}/adoption`, headers: H });
    const proof = (read.json() as { operation: { proof: Record<string, unknown> } }).operation.proof;
    expect((proof.candidate as { specDigest?: string }).specDigest).toBe(measured);

    // A proof the campaign never issued authorizes nothing, however well-formed it is.
    const forged = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: H,
      payload: { proof: { ...proof, gateDigest: "sha256:forged" }, spec },
    });
    expect(forged.statusCode, "a proof this campaign never issued was accepted").toBe(409);
    expect(await agents.has("acme", "everdict", "1.0.1"), "a refused adoption still wrote to the registry").toBe(false);

    // …and a correct proof carrying SUBSTITUTED bytes: the registry write lands (a version that did not
    // exist), and the spend is withheld because what it now resolves is not what the campaign measured.
    const substituted = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: H,
      payload: { proof, spec: { ...spec, instructions: "a different agent entirely" } },
    });
    expect(substituted.statusCode, "a substituted candidate was adopted under the measured label").toBe(409);
    expect(
      (
        (await app.inject({ method: "GET", url: `/campaigns/${id}/adoption`, headers: H })).json() as {
          operation: { state: string };
        }
      ).operation.state,
      "a refused adoption spent its authorization anyway",
    ).toBe("decided");

    // ⚠️ RE-AIMED (arch-review 76). This used to assert 409 here, because the substituted attempt above had
    // already written its bytes to the label and immutability then refused the honest caller — the test was
    // pinning the DEFECT. The digest is proved before the write now, so the label is untouched by a refused
    // attempt and the honest path is the one that lands.
    const adopted = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: H,
      payload: { proof, spec },
    });
    expect(adopted.statusCode, "a refused attempt poisoned the label the honest caller needed").toBe(200);
    expect((adopted.json() as { kind: string }).kind).toBe("adopted");
    expect(await agents.has("acme", "everdict", "1.0.1")).toBe(true);
    await app.close();
  });

  it("SPENDS the authorization once and converges on a retry", async () => {
    const spec = AgentSpecSchema.parse({ id: "everdict", version: "1.0.1", instructions: "structure first" });
    const seeded = new InMemoryAgentRegistry();
    await seeded.register("acme", spec, "alice");
    const measured = contentDigest(await seeded.get("acme", "everdict", "1.0.1"));
    const { app, agents } = build({
      ...winning,
      candidate: { record: { ...winning.candidate.record, manifest: { harness: { specDigest: measured } } } },
    });

    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame },
    });
    const { id } = opened.json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "structure over phrasing",
        learned: "the shorter instructions cut tool calls but the win sat on training rows only",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
      },
    });
    await app.inject({ method: "POST", url: `/campaigns/${id}/settle`, headers: H });
    const read = await app.inject({ method: "GET", url: `/campaigns/${id}/adoption`, headers: H });
    const proof = (read.json() as { operation: { proof: unknown } }).operation.proof;

    const first = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: H,
      payload: { proof, spec },
    });
    expect(first.statusCode, "the authorization cannot be spent from any transport").toBe(200);
    expect((first.json() as { kind: string }).kind).toBe("adopted");
    expect(await agents.has("acme", "everdict", "1.0.1"), "the registry never received the adopted version").toBe(true);

    // At-least-once retry: converges rather than granting a second adoption.
    const again = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: H,
      payload: { proof, spec },
    });
    expect((again.json() as { kind: string }).kind, "a retry was granted its own adoption").toBe("already_adopted");
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
        learned: "the shorter instructions cut tool calls but the win sat on training rows only",
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

// The harness lane needs a seeded template taxonomy to resolve; the agent lane drives the same closure and
// the same comparison, so these transport cases use it. `composition/adoption-is-spent.counterexample.test.ts`
// owns the closure's own behaviour.
function unusedHarnesses() {
  return {
    async register() {
      throw new Error("the harness lane is not exercised by these cases");
    },
    async get() {
      throw new Error("the harness lane is not exercised by these cases");
    },
  } as unknown as Parameters<typeof buildCampaignAdoption>[0]["harnesses"];
}

// The template half, unexercised for the same reason the harness lane is: resolving one needs a seeded
// taxonomy, and a double that skipped that would be testing a resolution production does not perform.
function unusedTemplates() {
  return {
    async get() {
      throw new Error("the harness lane is not exercised by these cases");
    },
  } as unknown as Parameters<typeof buildCampaignAdoption>[0]["templates"];
}

// An issue nobody has resolved — the ordinary case, and the one that leaves the completion join to the
// watcher. The cases that exercise the REVERSE ordering supply their own resolved issue.
function openIssue() {
  return {
    async get() {
      return { status: "in_progress" as const };
    },
  };
}

// ── THE EXAM IS THE ISSUE'S (docs/architecture/evolution-routing-spec.md §3) ─────────────────────────
//
// RED before the derivation existed: a body whose frame said `fromIssue` was refused at parse, and nothing
// could turn an issue's cases into a frame.
describe("POST /campaigns with frame.fromIssue — the issue's case links become the exam", () => {
  type Link = { type: string; id: string; version?: string; dataset?: string; addedBy: string; addedAt: string };
  const issueWith = (links: Link[]) => ({
    async get(_t: string, ref: string) {
      if (ref !== "iss_1") throw new NotFoundError("NOT_FOUND", { ref }, "issue not found");
      return { id: "iss_1", links };
    },
  });
  const datasets = {
    async get(_t: string, id: string, ref?: string) {
      if (id !== "tb" || ref !== "3") throw new NotFoundError("NOT_FOUND", { id, ref }, "dataset not found");
      return { cases: [{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "c4" }] };
    },
  };
  const appOver = (links: Link[]) => {
    const store = new InMemoryEvolutionCampaignStore();
    const issues = issueWith(links);
    const campaignService = new CampaignService({
      // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
      // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
      scorecards: { get: async () => undefined },
      store,
      operations: store,
      changes: noChanges,
      runs: noRuns,
      datasets,
      seedProvenance: noSeedProvenance,
      shape: noShape,
      evidence: new InMemoryCampaignEvidenceStore(),
      issues,
      diffs: { diffSnapshot: async () => winning },
      newId: () => "evc_from_issue",
      now: () => "2026-09-02T03:00:00.000Z",
    });
    const agents = new InMemoryAgentRegistry();
    return buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      campaignService,
      issueService: {
        async get(_t: string, ref: string) {
          return ref === "iss_1" ? { id: "iss_1" } : undefined;
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["issueService"]>,
      agentRegistry: agents,
      campaignAdoption: buildCampaignAdoption({
        operations: store,
        agents,
        harnesses: unusedHarnesses(),
        templates: unusedTemplates(),
        environments: new InMemoryEnvironmentRegistry(),
        issues: openIssue(),
      }),
    });
  };
  const { scenarios: _scenarios, targets: _targets, ...rest } = frame;
  void _scenarios;
  void _targets;
  const fromIssue = { fromIssue: true, ...rest };

  it("derives targets from the case links and holds out every other case of the pinned dataset version", async () => {
    const app = appOver([
      { type: "case", id: "c1", dataset: "tb", version: "3", addedBy: "a", addedAt: "t" },
      { type: "case", id: "c2", dataset: "tb", version: "3", addedBy: "a", addedAt: "t" },
      { type: "harness", id: "shop", addedBy: "a", addedAt: "t" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame: fromIssue },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().frame).toMatchObject({
      targets: ["c1", "c2"],
      scenarios: [
        { id: "c1", heldOut: false },
        { id: "c2", heldOut: false },
        { id: "c3", heldOut: true },
        { id: "c4", heldOut: true },
      ],
    });
    expect("fromIssue" in res.json().frame).toBe(false);
    await app.close();
  });

  it("refuses by name when the issue links no cases, and when the links pin two dataset versions", async () => {
    const none = appOver([{ type: "harness", id: "shop", addedBy: "a", addedAt: "t" }]);
    const r1 = await none.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame: fromIssue },
    });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().message).toMatch(/links no cases/);
    await none.close();
    const mixed = appOver([
      { type: "case", id: "c1", dataset: "tb", version: "3", addedBy: "a", addedAt: "t" },
      { type: "case", id: "c2", dataset: "tb", version: "4", addedBy: "a", addedAt: "t" },
    ]);
    const r2 = await mixed.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame: fromIssue },
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().message).toMatch(/2 versions of dataset tb/);
    await mixed.close();
  });
});

// ── THE EVIDENCE A ROUND SEALED, OVER HTTP (docs/architecture/benchmark-evidence-spec.md §3) ───────────
describe("GET /campaigns/:id/rounds/:seq/evidence", () => {
  it("serves the sealed record, 404s a round with none, 400s a non-integer seq", async () => {
    const { app } = build(winning);
    const open = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame },
    });
    const id = open.json().id as string;
    const logged = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "shorter instructions",
        learned: "the tool budget was the binding constraint",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-base",
        candidateScorecardId: "sc-win",
      },
    });
    expect(logged.statusCode, logged.body).toBe(201);
    const evidence = await app.inject({ method: "GET", url: `/campaigns/${id}/rounds/1/evidence`, headers: H });
    expect(evidence.statusCode, evidence.body).toBe(200);
    expect(evidence.json()).toMatchObject({ campaignId: id, seq: 1, aggregate: { comparable: true } });
    expect(evidence.json().cases.map((c: { caseId: string; verdict: string }) => [c.caseId, c.verdict])).toEqual([
      ["c1", "improved"],
      ["c2", "unchanged"],
    ]);
    expect(
      (await app.inject({ method: "GET", url: `/campaigns/${id}/rounds/7/evidence`, headers: H })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/campaigns/${id}/rounds/x/evidence`, headers: H })).statusCode,
    ).toBe(400);
    await app.close();
  });
});

// ── THE NEXT ROUND'S HANDOFF, OVER HTTP ────────────────────────────────────────────────────────────────
//
// The read that makes a delegation a contract: an agent fetches this and passes it to `create_sandbox` as
// `brief`. What the transport case is here to pin is the ORACLE BOUNDARY reaching the wire — `frame` above is
// all held-out (c1, c2) with no targets, which is the strongest version of the question: a brief for it may
// name no scenario at all, because every scenario in it is the generalization population.
describe("GET /campaigns/:id/brief", () => {
  it("serves a brief the delegate can act on, and names no held-out scenario", async () => {
    const { app } = build(winning);
    const open = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame },
    });
    const id = open.json().id as string;

    const before = await app.inject({ method: "GET", url: `/campaigns/${id}/brief`, headers: H });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().goal).toMatch(/do not change the evaluation/);
    expect(before.json().doneWhen.join("\n")).toMatch(/build and tests pass/);
    expect(before.json().context).toMatch(/Round 1 of campaign/);
    expect(JSON.stringify(before.json()), "a held-out id on the wire is the whole defect").not.toMatch(/"c1"|"c2"/);

    await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "shorter instructions",
        learned: "the tool budget was the binding constraint, not the prompt",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-base",
        candidateScorecardId: "sc-win",
      },
    });
    const after = await app.inject({ method: "GET", url: `/campaigns/${id}/brief`, headers: H });
    expect(after.statusCode, after.body).toBe(200);
    // Round 2 now, and the finding travels — that is what the next proposal is supposed to be shaped by.
    expect(after.json().context).toMatch(/Round 2 of campaign/);
    expect(after.json().context).toMatch(/tool budget was the binding constraint/);
    // …and the evidence the round sealed still buys the delegate no held-out coordinate.
    expect(JSON.stringify(after.json())).not.toMatch(/"c1"|"c2"/);
    expect((await app.inject({ method: "GET", url: "/campaigns/evc_missing/brief", headers: H })).statusCode).toBe(404);
    await app.close();
  });
});

// ── ONE CAPABILITY'S EVOLUTION MEMORY (docs/architecture/evolution-routing-spec.md §5) ────────────────
describe("GET /campaigns?subjectType=&subjectId=", () => {
  it("narrows to the subject's campaigns, and refuses a half-named subject", async () => {
    const { app } = build(winning);
    await app.inject({ method: "POST", url: "/campaigns", headers: H, payload: { issueId: "iss_1", frame } });
    const mine = await app.inject({
      method: "GET",
      url: "/campaigns?subjectType=agent&subjectId=everdict",
      headers: H,
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toHaveLength(1);
    const other = await app.inject({
      method: "GET",
      url: "/campaigns?subjectType=harness&subjectId=everdict",
      headers: H,
    });
    expect(other.json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/campaigns?subjectType=agent", headers: H })).statusCode).toBe(400);
    await app.close();
  });
});

// ── AN ENVIRONMENT CAMPAIGN (docs/architecture/harness-definability-spec.md §2) ───────────────────────
//
// The subject is the world a case acts on, so every identity check inverts: the harness is the held constant
// and the environment is the treatment. Which means (a) the coordinates come from each side's manifest SEAL
// rather than from the scorecard's harness stamp, (b) an `environment` confound is the experiment happening
// and not a reason to reject, and (c) the harness staying equal is a check nothing else performs — identity
// deliberately excludes the harness axis, because for every other subject the harness IS the treatment.
const envFrame: CampaignFrame = {
  ...frame,
  subject: { type: "environment", id: "shop", baselineVersion: "1.0.0" },
};
const envSnapshot = (over: {
  baselineEnv?: string;
  candidateEnv?: string;
  candidateHarnessVersion?: string;
}): CampaignSnapshot => ({
  diff: {
    ...winning.diff,
    // The environment axis reports a VERIFIED difference, which for any other subject would reject the round.
    experiment: {
      held: ["execution_world"],
      confounds: [{ axis: "environment", detail: "1 case(s) ran against a different environment document" }],
      unverified: [],
    },
  },
  baseline: {
    record: {
      harness: { id: "agent:everdict", version: "1.0.0" },
      manifest: { environments: { c1: { ref: `shop@${over.baselineEnv ?? "1.0.0"}` } } },
    },
  },
  candidate: {
    record: {
      harness: { id: "agent:everdict", version: over.candidateHarnessVersion ?? "1.0.0" },
      manifest: {
        harness: { specDigest: "sha256:cand-env" },
        environments: { c1: { ref: `shop@${over.candidateEnv ?? "2.0.0"}` } },
      },
    },
  },
});

describe("campaign routes — an environment subject", () => {
  const openAndLog = async (snapshot: CampaignSnapshot, candidateVersion: string) => {
    const { app } = build(snapshot);
    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame: envFrame },
    });
    expect(opened.statusCode).toBe(201);
    const { id } = opened.json() as { id: string };
    const logged = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "the seed repository's fixtures were the binding constraint",
        learned: "the new fixture set removes the login wall the agent kept failing at",
        candidateVersion,
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
      },
    });
    return { app, logged };
  };

  it("verifies the sides from the SEAL and counts the environment axis as the treatment, not a confound", async () => {
    const { app, logged } = await openAndLog(envSnapshot({}), "2.0.0");
    expect(logged.statusCode).toBe(201);
    const round = (logged.json() as { round: { verdict: { comparable: boolean; confoundedAxes: string[] } } }).round;
    expect(round.verdict.comparable).toBe(true);
    expect(round.verdict.confoundedAxes).toEqual([]);
    await app.close();
  });

  it("refuses a round whose candidate scorecard ran a different environment version than the one declared", async () => {
    const { app, logged } = await openAndLog(envSnapshot({ candidateEnv: "3.0.0" }), "2.0.0");
    expect(logged.statusCode).toBe(400);
    expect(logged.json()).toMatchObject({ message: expect.stringContaining("shop@3.0.0") });
    await app.close();
  });

  it("refuses a round whose baseline ran a version the frame did not freeze", async () => {
    const { app, logged } = await openAndLog(envSnapshot({ baselineEnv: "0.9.0" }), "2.0.0");
    expect(logged.statusCode).toBe(400);
    expect(logged.json()).toMatchObject({ message: expect.stringContaining("not the frame's baseline") });
    await app.close();
  });

  it("refuses a round where the HARNESS also moved — nothing else in identity would catch it", async () => {
    const { app, logged } = await openAndLog(envSnapshot({ candidateHarnessVersion: "1.0.1" }), "2.0.0");
    expect(logged.statusCode).toBe(400);
    expect(logged.json()).toMatchObject({ message: expect.stringContaining("holds the harness constant") });
    await app.close();
  });

  it("refuses a round whose scorecards sealed no version of the subject at all", async () => {
    const bare: CampaignSnapshot = {
      diff: envSnapshot({}).diff,
      baseline: { record: { harness: { id: "agent:everdict", version: "1.0.0" } } },
      candidate: {
        record: {
          harness: { id: "agent:everdict", version: "1.0.0" },
          manifest: { harness: { specDigest: "sha256:cand-env" } },
        },
      },
    };
    const { app, logged } = await openAndLog(bare, "2.0.0");
    expect(logged.statusCode).toBe(400);
    expect(logged.json()).toMatchObject({ message: expect.stringContaining("sealed no version of environment") });
    await app.close();
  });
});

// ── THE CODE HALF, OVER HTTP (docs/architecture/code-evolution-loop.md, D5) ──────────────────────────
//
// `POST /campaigns/:id/merge` spends the same authorization `adopt` does, on its second effect: the pull request
// the adopted bytes were built from lands on the default branch through the workspace GitHub App. Pinned here:
// the ordering (bytes first), the effect's inputs (the STORED pull request and the measured head, never a body
// field), and the deployment with no App answering by name rather than by silence.
describe("POST /campaigns/:id/merge pays the adoption's code debt", () => {
  const agentSpec = (id: string, version: string) => ({
    id,
    version,
    description: "the agent under evolution",
    instructions: "be brief",
    mcpServers: [],
    capabilities: [],
    tags: [],
    disabledDefaults: [],
    toolSecretBindings: {},
    triggers: [],
    enabled: true,
  });
  const candidateSpec = agentSpec("everdict", "1.0.1");
  // A candidate built from a pull request: the scorecard's origin names it, so the close records a code debt.
  const fromPr: CampaignSnapshot = {
    ...winning,
    candidate: {
      record: {
        harness: { id: "agent:everdict", version: "1.0.1" },
        manifest: { harness: { specDigest: contentDigest(candidateSpec) } },
        origin: { source: "github-actions", repo: "acme/agent", sha: "abc123", prNumber: 7 },
      },
    },
  } as CampaignSnapshot;

  function build(
    github: { mergePullRequest: (...args: unknown[]) => Promise<{ sha: string; alreadyMerged: boolean }> } | undefined,
  ) {
    const store = new InMemoryEvolutionCampaignStore();
    const campaignService = new CampaignService({
      // The frame's positive control (`exam-proof.ts`). No fixture here names one, so this is never read;
      // it is REQUIRED on the deps because an optional capability hides an unwired composition root.
      scorecards: { get: async () => undefined },
      store,
      operations: store,
      changes: noChanges,
      runs: noRuns,
      datasets: noDatasets,
      seedProvenance: noSeedProvenance,
      shape: noShape,
      evidence: new InMemoryCampaignEvidenceStore(),
      issues: {
        async get(_t: string, ref: string) {
          if (ref !== "iss_1") throw new NotFoundError("NOT_FOUND", { ref }, "issue not found");
          return { id: "iss_1" };
        },
      },
      diffs: { diffSnapshot: async () => fromPr },
      newId: () => "evc_code",
      now: () => "2026-09-02T03:00:00.000Z",
    });
    const agents = new InMemoryAgentRegistry();
    const merges: unknown[][] = [];
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      campaignService,
      issueService: {
        async get(_t: string, ref: string) {
          return ref === "iss_1" ? { id: "iss_1" } : undefined;
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["issueService"]>,
      agentRegistry: agents,
      campaignAdoption: buildCampaignAdoption({
        operations: store,
        agents,
        harnesses: unusedHarnesses(),
        templates: unusedTemplates(),
        environments: new InMemoryEnvironmentRegistry(),
        issues: openIssue(),
        ...(github !== undefined
          ? {
              github: {
                mergePullRequest: async (...args: unknown[]) => {
                  merges.push(args);
                  return await github.mergePullRequest(...args);
                },
              } as unknown as NonNullable<Parameters<typeof buildCampaignAdoption>[0]["github"]>,
            }
          : {}),
      }),
    });
    return { app, store, merges };
  }

  async function settled(app: ReturnType<typeof build>["app"]) {
    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_1", frame },
    });
    const { id } = opened.json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "structure over phrasing",
        learned: "the shorter instructions cut tool calls but the win sat on training rows only",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
      },
    });
    const settledRes = await app.inject({ method: "POST", url: `/campaigns/${id}/settle`, headers: H });
    expect(settledRes.statusCode, "the fixture did not adopt, so the case measures nothing").toBe(200);
    const read = await app.inject({ method: "GET", url: `/campaigns/${id}/adoption`, headers: H });
    const operation = (read.json() as { operation: { proof: unknown; code?: { state: string } } }).operation;
    expect(operation.code?.state, "the close recorded no code debt").toBe("owed");
    return { id, proof: operation.proof };
  }

  it("REFUSES to merge before the bytes are registered, then merges the STORED pull request at the measured head", async () => {
    const { app, merges } = build({ mergePullRequest: async () => ({ sha: "m1", alreadyMerged: false }) });
    const { id, proof } = await settled(app);
    const early = await app.inject({ method: "POST", url: `/campaigns/${id}/merge`, headers: H, payload: { proof } });
    expect(early.statusCode, "code was promoted before its bytes were registered").toBe(409);
    expect(merges).toEqual([]);

    const adopted = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: H,
      payload: { proof, spec: candidateSpec },
    });
    expect(adopted.statusCode, JSON.stringify(adopted.json())).toBe(200);
    const merged = await app.inject({ method: "POST", url: `/campaigns/${id}/merge`, headers: H, payload: { proof } });
    expect(merged.statusCode, JSON.stringify(merged.json())).toBe(200);
    expect((merged.json() as { kind: string; sha: string }).sha).toBe("m1");
    // The effect saw the repository, pull request and head the ROUND recorded — nothing the caller sent.
    expect(merges[0]?.slice(0, 3)).toEqual(["acme", "acme/agent", 7]);
    expect(merges[0]?.[3]).toMatchObject({ sha: "abc123" });
    const read = await app.inject({ method: "GET", url: `/campaigns/${id}/adoption`, headers: H });
    expect((read.json() as { operation: { code: unknown } }).operation.code).toMatchObject({
      state: "merged",
      mergedSha: "m1",
    });
    await app.close();
  });

  it("a deployment with no GitHub App answers by name — the debt stays owed, nothing pretends to have merged", async () => {
    const { app } = build(undefined);
    const { id, proof } = await settled(app);
    await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: H,
      payload: { proof, spec: candidateSpec },
    });
    const merged = await app.inject({ method: "POST", url: `/campaigns/${id}/merge`, headers: H, payload: { proof } });
    expect(merged.statusCode).toBe(404);
    expect((merged.json() as { message: string }).message).toMatch(/no workspace GitHub App/);
    const read = await app.inject({ method: "GET", url: `/campaigns/${id}/adoption`, headers: H });
    expect((read.json() as { operation: { code: { state: string } } }).operation.code.state).toBe("owed");
    await app.close();
  });
});
