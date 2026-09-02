import { CampaignService, type CampaignSnapshot, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { CampaignFrame } from "@everdict/contracts";
import { AgentSpecSchema } from "@everdict/contracts";
import { NotFoundError, readUnknown } from "@everdict/contracts";
import { InMemoryEvolutionCampaignStore, InMemoryRunStore } from "@everdict/db";
import { contentDigest } from "@everdict/domain";
import { InMemoryAgentRegistry } from "@everdict/registry";
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
  observationPolicy: { allowDivergent: false },
};

function build(snapshot: CampaignSnapshot) {
  const store = new InMemoryEvolutionCampaignStore();
  const campaignService = new CampaignService({
    store,
    operations: store,
    changes: noChanges,
    runs: noRuns,
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
    // …and the SAME registry the adoption writes through is what the route's second gate reads (arch-review
    // 119). It was absent here, so `teamOfEntity(undefined, …)` answered `{}` — the permissive arm — and the
    // gate could not refuse in any test in this file. The registry is empty, which is the unowned shape these
    // cases mean; the difference is that it is now a fact the fixture states rather than one it omits.
    agentRegistry: agents,
    campaignAdoption: buildCampaignAdoption({
      operations: store,
      agents,
      harnesses: unusedHarnesses(),
      templates: unusedTemplates(),
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

// ── A CAMPAIGN IS A TEAM'S, AND ANOTHER TEAM MAY NOT REACH IT (arch-review 81) ──────────────────────
//
// arch-review 76 gave campaigns a team and gated every surface on it, and arch-review 78/79 closed three
// spellings that made the gate evaporate. None of them shipped a test that DRIVES a cross-team caller — a
// guard nobody has seen refuse is a comment (rule `testing`), and this whole family of holes was found by
// reading rather than by anything going red.
//
// `teamService` is the one place team privacy is decided, so the double answers for it exactly: Team B's
// member is on team-b, sees team-b, and is on no other roster.
//
// Seen RED with each gate removed in turn, observed:
//   open      201 — a campaign was created inside another team
//   rounds    201 — another team's append-only evidence was extended
//   get       200 — a private team's campaign, its issue id and its hypotheses were readable
//   settle    200 — another team's campaign was closed
function crossTeam() {
  const store = new InMemoryEvolutionCampaignStore();
  const campaignService = new CampaignService({
    store,
    operations: store,
    changes: noChanges,
    runs: noRuns,
    // Both issues exist; they belong to different teams. Knowing the id is exactly what used to be enough.
    issues: {
      async get(_t: string, ref: string) {
        return ref === "iss_a" ? { id: "iss_a", teamId: "team-a" } : { id: "iss_b", teamId: "team-b" };
      },
    },
    diffs: { diffSnapshot: async () => winning },
    newId: () => `camp_${Math.random().toString(36).slice(2, 8)}`,
    now: () => "2026-08-27T05:00:00.000Z",
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    campaignService,
    issueService: {
      async get(_t: string, ref: string) {
        return ref === "iss_a" ? { id: "iss_a", teamId: "team-a" } : { id: "iss_b", teamId: "team-b" };
      },
    } as unknown as NonNullable<Parameters<typeof buildServer>[0]["issueService"]>,
    // The caller is on team-b only, and cannot see team-a.
    teamService: {
      async list() {
        return [{ id: "team-b" }];
      },
      async defaultTeam() {
        return undefined;
      },
      async visibleTeamIds() {
        return ["team-b"];
      },
      async canSeeTeam(_t: string, teamId: string) {
        return teamId === "team-b";
      },
    } as unknown as NonNullable<Parameters<typeof buildServer>[0]["teamService"]>,
  });
  return { app, campaignService };
}

describe("[R81 COUNTEREXAMPLE] a campaign belongs to a team, and another team cannot reach it", () => {
  it("REFUSES to open a campaign inside a team the caller is not on", async () => {
    const { app } = crossTeam();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_a", frame },
    });
    expect(res.statusCode, "a campaign was created inside another team").not.toBe(201);
    await app.close();
  });

  it("REFUSES to write into a VISIBLE team the caller is not on — privacy and membership are different", async () => {
    // ⚠️ The case the first version of this file did not have, and neutralization is what said so:
    // removing the open route's `gate(..., {teamId})` failed NOTHING, because `assertTeamVisible` already
    // refused a team the caller could not SEE. Those are two questions and the kernel answers them apart —
    // READ is decided by team privacy (404), WRITE by the roster (403). A team that is not private but not
    // mine passes the first and must fail the second, and only that case proves the gate.
    const store = new InMemoryEvolutionCampaignStore();
    const issues = {
      async get(_t: string, ref: string) {
        return ref === "iss_a" ? { id: "iss_a", teamId: "team-a" } : { id: "iss_b", teamId: "team-b" };
      },
    };
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      campaignService: new CampaignService({
        store,
        operations: store,
        changes: noChanges,
        runs: noRuns,
        issues,
        diffs: { diffSnapshot: async () => winning },
        newId: () => "camp_open",
        now: () => "2026-08-27T05:00:00.000Z",
      }),
      issueService: issues as unknown as NonNullable<Parameters<typeof buildServer>[0]["issueService"]>,
      teamService: {
        async list() {
          return [{ id: "team-b" }]; // the caller's roster: team-b only
        },
        async defaultTeam() {
          return undefined;
        },
        async visibleTeamIds() {
          return undefined; // nothing is hidden — team-a is a normal, non-private team
        },
        async canSeeTeam() {
          return true;
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["teamService"]>,
      // ⚠️ A MEMBER, and `requireAuth` so the dev-header fallback cannot answer instead. An admin governs
      // every team in the workspace BY DESIGN (`canReachTeam` says so), so an admin fixture "proves" this
      // gate by bypassing it — which is exactly what the first draft of this case did, silently, because
      // the dev fallback hands out `roles: ["admin"]`.
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject: "u-b", workspace: "acme", roles: ["member"], via: "oidc" as const };
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["authenticator"]>,
    });

    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: { authorization: "Bearer t" },
      payload: { issueId: "iss_a", frame },
    });
    expect(res.statusCode, "a campaign was opened in a team the caller is not a member of").toBe(403);
    await app.close();
  });

  it("ALLOWS the caller's own team — the control", async () => {
    // A gate that refused everything would be a feature nobody can use, which is the other way to fail.
    const { app } = crossTeam();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: H,
      payload: { issueId: "iss_b", frame },
    });
    expect(res.statusCode, "the caller could not open a campaign in their OWN team").toBe(201);
    await app.close();
  });

  it("HIDES another team's campaign from read, round and settle", async () => {
    const { app, campaignService } = crossTeam();
    // Seeded through the service, so the row is exactly what an open in team-a produces.
    const foreign = await campaignService.open("acme", { issueId: "iss_a", frame }, "someone-on-team-a");
    expect(foreign.teamId).toBe("team-a");

    for (const [method, url] of [
      ["GET", `/campaigns/${foreign.id}`],
      ["GET", `/campaigns/${foreign.id}/decision`],
      ["GET", `/campaigns/${foreign.id}/adoption`],
      ["POST", `/campaigns/${foreign.id}/settle`],
    ] as const) {
      const res = await app.inject({ method, url, headers: H });
      expect(res.statusCode, `${method} ${url} exposed another team's campaign`).toBe(404);
    }

    const round = await app.inject({
      method: "POST",
      url: `/campaigns/${foreign.id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "h",
        learned: "the shorter instructions cut tool calls but the win sat on training rows only",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
      },
    });
    expect(round.statusCode, "another team's append-only evidence was extended").toBe(404);

    // …and it is not on this caller's list either.
    const list = await app.inject({ method: "GET", url: "/campaigns", headers: H });
    expect((list.json() as Array<{ id: string }>).map((c) => c.id)).not.toContain(foreign.id);
    await app.close();
  });
});

// ── THE SECOND GATE ON ADOPT, SEEN REFUSING (arch-review 114) ────────────────────────────────────────
//
// `POST /campaigns/:id/adopt` gates TWICE, and the two answer different questions: the campaign's team,
// frozen at open, says who may spend this authorization; `teamOfEntity` says who owns the agent about to gain
// a version. The frozen half is what lets the record comment promise that a later `POST /issues/:id/team`
// cannot WIDEN what an adoption may do — the entity's live owner still has to say yes.
//
// Nothing had ever seen that second gate refuse. The `build()` harness does not pass `agentRegistry` to
// `buildServer`, so `teamOfEntity(undefined, …)` returned `{}` — no team constraint, the permissive arm — in
// every adopt test in this file. A promise resting on a guard nobody has watched refuse is a comment
// (rule `testing`), which is the whole reason this exists.
//
// ⚠️ `requireAuth` + a MEMBER authenticator, because the dev-header fallback hands out `roles: ["admin"]` and
// an admin governs every team by design — an admin fixture would "pass" by bypassing the gate.
describe("[arch-review 114] adopting an agent owned by another team is refused", () => {
  // A REAL spec whose REAL digest the snapshot seals. Two earlier drafts of this fixture were wrong in ways
  // that look identical from outside — a malformed spec, then a missing one — and both surfaced as a 500 that
  // a `not.toBe(403)` control happily accepted. A control that passes on an error proves nothing about the
  // gate it is the control for.
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
  // The campaign must have MEASURED these bytes, or the adoption is refused for a digest mismatch long before
  // — and after — the gate, which would hide whichever answer we are asking about.
  const sealed: CampaignSnapshot = {
    ...winning,
    candidate: {
      record: {
        harness: { id: "agent:everdict", version: "1.0.1" },
        manifest: { harness: { specDigest: contentDigest(candidateSpec) } },
      },
    },
  } as CampaignSnapshot;

  function ownedElsewhere(callerTeams: string[]) {
    const store = new InMemoryEvolutionCampaignStore();
    const campaignService = new CampaignService({
      store,
      operations: store,
      changes: noChanges,
      runs: noRuns,
      issues: {
        async get(_t: string, ref: string) {
          if (ref !== "iss_1") throw new NotFoundError("NOT_FOUND", { ref }, "issue not found");
          return { id: "iss_1" }; // unowned issue → the campaign's own team never refuses here
        },
      },
      diffs: { diffSnapshot: async () => sealed },
      newId: () => "evc_owned",
      now: () => "2026-08-28T03:00:00.000Z",
    });
    const agents = new InMemoryAgentRegistry();
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      campaignService,
      issueService: {
        async get(_t: string, ref: string) {
          return ref === "iss_1" ? { id: "iss_1" } : undefined;
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["issueService"]>,
      // WIRED, unlike `build()` used to be — without this the gate below has no resource to ask about, which
      // is why this describe exists at all. `build()` now wires it too (arch-review 119), so the weak branch
      // that made this block necessary no longer exists anywhere in the file.
      agentRegistry: agents,
      campaignAdoption: buildCampaignAdoption({
        operations: store,
        agents,
        harnesses: unusedHarnesses(),
        templates: unusedTemplates(),
        issues: openIssue(),
      }),
      teamService: {
        async list() {
          return callerTeams.map((id) => ({ id }));
        },
        async defaultTeam() {
          return undefined;
        },
        async visibleTeamIds() {
          return undefined; // nothing hidden — this is about WRITING, not seeing
        },
        async canSeeTeam() {
          return true;
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["teamService"]>,
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject: "u-b", workspace: "acme", roles: ["member"], teams: callerTeams, via: "oidc" as const };
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["authenticator"]>,
    });
    return { app, agents, store };
  }

  async function settledCampaign(app: ReturnType<typeof ownedElsewhere>["app"]) {
    const A = { authorization: "Bearer t" };
    const opened = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: A,
      payload: { issueId: "iss_1", frame },
    });
    expect(opened.statusCode, "the fixture could not open a campaign, so it measures nothing").toBe(201);
    const { id } = opened.json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/campaigns/${id}/rounds`,
      headers: A,
      payload: {
        hypothesis: "structure over phrasing",
        learned: "the shorter instructions cut tool calls but the win sat on training rows only",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
      },
    });
    const settled = await app.inject({ method: "POST", url: `/campaigns/${id}/settle`, headers: A });
    expect(settled.statusCode, "the fixture did not reach an adoption, so it measures nothing").toBe(200);
    expect((settled.json() as { record: { state: string } }).record.state).toBe("adopted");
    // The authorization is its OWN read — `operation: null` there is the answer "this campaign authorized
    // nothing", which is exactly the state that would make the gate below untested.
    const read = await app.inject({ method: "GET", url: `/campaigns/${id}/adoption`, headers: A });
    const operation = (read.json() as { operation: { proof: unknown } | null }).operation;
    return { id, proof: operation?.proof };
  }

  it("REFUSES when the candidate agent belongs to a team the caller is not on", async () => {
    const { app, agents } = ownedElsewhere(["team-b"]);
    // The agent under evolution is team-a's. The caller is on team-b only.
    // ⚠️ Registered as `everdict`, not `agent:everdict`: the proof's candidate id is the harness id with the
    // `agent:` prefix stripped, and the first draft registered the prefixed spelling — so `ownVersions` found
    // nothing, `teamOfEntity` answered `{}` (the permissive arm) and the gate never even looked at a team.
    // A fixture that misses the resource proves the guard is absent, not present.
    await agents.register("acme", agentSpec("everdict", "1.0.0") as never, "u-a", "team-a");
    const { id, proof } = await settledCampaign(app);
    expect(proof, "the settle authorized nothing, so the gate below is untested").toBeDefined();

    const res = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: { authorization: "Bearer t" },
      payload: { proof, spec: candidateSpec },
    });
    expect(res.statusCode, "another team's agent gained a version").toBe(403);
    await app.close();
  });

  it("ALLOWS the owning team — the control that keeps the gate from being a wall", async () => {
    const { app, agents } = ownedElsewhere(["team-a"]);
    await agents.register("acme", agentSpec("everdict", "1.0.0") as never, "u-a", "team-a");
    const { id, proof } = await settledCampaign(app);
    const res = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: { authorization: "Bearer t" },
      payload: { proof, spec: candidateSpec },
    });
    // A REAL adoption, not merely "not 403". Two drafts of this control passed on a 500, which is how a
    // fixture that never reaches the effect certifies a gate it never exercised.
    expect(res.statusCode, "the agent's own team was refused its adoption").toBe(200);
    expect((res.json() as { kind: string }).kind).toBe("adopted");
    await app.close();
  });
});

// ── THE CAMPAIGN'S TEAM IS READ FROM THE CAMPAIGN, NOT FROM THE PROOF THE CALLER HANDED OVER ─────────
//
// The adopt route gated `scorecards:run` against `body.proof.teamId`. The campaign record — already read two
// lines above for the visibility check — carries the same team, frozen at open, and it is the platform's
// value; the proof's copy is whatever the caller sent. A proof with the field STRIPPED skipped the gate
// entirely, and only the service's digest comparison, several reads later, turned that into a 409 — a
// caller-authored value deciding whether a team gate runs at all (rule `protocol` L3). The residue class of
// that guard is "a proof that omits the team", and nobody had written it (skill `code-review`, pass 5).
//
// RED before the fix: 409 (the digest refused it) where a member of another team owes a 403.
describe("[COUNTEREXAMPLE] adopt gates the campaign's OWN team, whatever the presented proof says", () => {
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
  const sealed: CampaignSnapshot = {
    ...winning,
    candidate: {
      record: {
        harness: { id: "agent:everdict", version: "1.0.1" },
        manifest: { harness: { specDigest: contentDigest(candidateSpec) } },
      },
    },
  } as CampaignSnapshot;

  // The campaign belongs to team-a (its issue's team); the agent under evolution belongs to team-b. A caller on
  // team-b only passes the ENTITY gate, so the only thing standing between them and the effect is the
  // campaign's own team gate — which is the gate under test.
  function teamedCampaign(callerTeams: string[]) {
    const store = new InMemoryEvolutionCampaignStore();
    const campaignService = new CampaignService({
      store,
      operations: store,
      changes: noChanges,
      runs: noRuns,
      issues: {
        async get(_t: string, ref: string) {
          if (ref !== "iss_a") throw new NotFoundError("NOT_FOUND", { ref }, "issue not found");
          return { id: "iss_a", teamId: "team-a" };
        },
      },
      diffs: { diffSnapshot: async () => sealed },
      newId: () => "evc_teamed",
      now: () => "2026-09-02T03:00:00.000Z",
    });
    const agents = new InMemoryAgentRegistry();
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      campaignService,
      issueService: {
        async get(_t: string, ref: string) {
          return ref === "iss_a" ? { id: "iss_a", teamId: "team-a" } : undefined;
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["issueService"]>,
      agentRegistry: agents,
      campaignAdoption: buildCampaignAdoption({
        operations: store,
        agents,
        harnesses: unusedHarnesses(),
        templates: unusedTemplates(),
        issues: openIssue(),
      }),
      teamService: {
        async list() {
          return callerTeams.map((id) => ({ id }));
        },
        async defaultTeam() {
          return undefined;
        },
        async visibleTeamIds() {
          return undefined; // team-a is visible to everybody — this is about WRITING into it
        },
        async canSeeTeam() {
          return true;
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["teamService"]>,
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject: "u", workspace: "acme", roles: ["member"], teams: callerTeams, via: "oidc" as const };
        },
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]["authenticator"]>,
    });
    return { app, agents, store, campaignService };
  }

  // Seeded through the service by someone on team-a, so the row is exactly what an open in team-a produces —
  // and settled the same way, so the operation is the one a real close writes.
  async function adoptedInTeamA(campaignService: CampaignService, store: InMemoryEvolutionCampaignStore) {
    const opened = await campaignService.open("acme", { issueId: "iss_a", frame }, "someone-on-team-a");
    expect(opened.teamId).toBe("team-a");
    await campaignService.logRound(
      "acme",
      opened.id,
      {
        hypothesis: "structure over phrasing",
        learned: "the shorter instructions cut tool calls but the win sat on training rows only",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-b",
        candidateScorecardId: "sc-c",
      },
      "someone-on-team-a",
      {},
    );
    const settled = await campaignService.settle("acme", opened.id, "someone-on-team-a");
    expect(settled.record.state).toBe("adopted");
    const operation = await store.forCampaign("acme", opened.id);
    expect(operation?.proof.teamId, "the proof carries no team, so the case cannot strip one").toBe("team-a");
    return { id: opened.id, proof: operation?.proof as Record<string, unknown> };
  }

  it("REFUSES (403) a team-b member presenting the campaign's proof with its team stripped", async () => {
    const { app, agents, store, campaignService } = teamedCampaign(["team-b"]);
    await agents.register("acme", agentSpec("everdict", "1.0.0") as never, "u-b", "team-b");
    const { id, proof } = await adoptedInTeamA(campaignService, store);
    const { teamId: _stripped, ...forged } = proof;
    const res = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: { authorization: "Bearer t" },
      payload: { proof: forged, spec: candidateSpec },
    });
    expect(res.statusCode, "a caller outside the campaign's team reached past its team gate").toBe(403);
    await app.close();
  });

  it("ALLOWS a member of both teams with the genuine proof — the control", async () => {
    const { app, agents, store, campaignService } = teamedCampaign(["team-a", "team-b"]);
    await agents.register("acme", agentSpec("everdict", "1.0.0") as never, "u-b", "team-b");
    const { id, proof } = await adoptedInTeamA(campaignService, store);
    const res = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/adopt`,
      headers: { authorization: "Bearer t" },
      payload: { proof, spec: candidateSpec },
    });
    expect(res.statusCode, "the campaign's own team was refused its adoption").toBe(200);
    expect((res.json() as { kind: string }).kind).toBe("adopted");
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
      store,
      operations: store,
      changes: noChanges,
      runs: noRuns,
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
