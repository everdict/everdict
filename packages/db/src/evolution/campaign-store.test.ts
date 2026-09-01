import {
  type AdoptionOperationStore,
  type CampaignComparison,
  CampaignService,
  type CampaignSnapshot,
  type EvolutionCampaignStore,
  type OutboxEvent,
} from "@everdict/application-control";
import type { CampaignFrame, CampaignRound, EvolutionCampaignRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError, NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryEvolutionCampaignStore, PgEvolutionCampaignStore } from "./campaign-store.js";

// ── The campaign settlement: store guards + the service's derived verdicts (Track D) ─────────────────
//
// The in-memory twin makes the SAME decisions as Postgres (the append CAS, the close CAS on state AND round
// count), so these units exercise the refusals production would give; the Pg half is additionally pinned at
// the SQL layer (fake SqlClient — the guards must live in the statement's WHERE, not in a read-then-write).

const frame: CampaignFrame = {
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  // Both HELD OUT (arch-review 71 P1-high). The frame used to mark `c1` as training and these cases then
  // improved on `c1` alone — which the gate accepted, and which is exactly the defect the held-out split
  // closes: the loop adopting on the scenarios it had been optimizing against. The schema also requires at
  // least two held-out scenarios now, because one that moved is a coin flip wearing the word evidence.
  scenarios: [
    { id: "c1", heldOut: true },
    { id: "c2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  // The statistics this campaign is judged by, frozen like everything else the verdict depends on. The
  // fixture carries the REAL shape rather than `{}` — a default that omits a declaration turns every test
  // that does not care about statistics into a test of the undeclared branch, which is how a fixture
  // population drifts onto the weak arm (rule protocol, the fixture-drift law).
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 },
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  observationPolicy: { allowDivergent: false },
};

const round = (seq: number, over: Partial<CampaignRound["verdict"]> = {}): CampaignRound => ({
  seq,
  hypothesis: "structure over phrasing",
  candidateVersion: `1.0.${seq}`,
  baselineScorecardId: "sc-base",
  candidateScorecardId: `sc-cand-${seq}`,
  verdict: {
    comparable: true,
    significantImprovements: 0,
    significantRegressions: 0,
    unverifiedAxes: [],
    confoundedAxes: [],
    ...over,
  },
  at: "2026-08-26T00:00:00.000Z",
  by: "agent:everdict",
});

const record = (over: Partial<EvolutionCampaignRecord> = {}): EvolutionCampaignRecord => ({
  id: "evc_1",
  tenant: "acme",
  issueId: "iss_1",
  frame,
  frameDigest: "sha256:frame",
  rounds: [],
  state: "open",
  createdBy: "alice",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  ...over,
});

const CLOSE = {
  outcome: { kind: "halted" as const, reason: "no_improvement" as const, detail: "dry" },
  at: "2026-08-26T01:00:00.000Z",
  by: "alice",
};

describe("InMemoryEvolutionCampaignStore — the guards answer, they never assume", () => {
  it("appends only against the expected round count — a stale writer gets conflict, not last-write-wins", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record());
    expect(await store.appendRound("acme", "evc_1", round(1), 0)).toEqual({ kind: "appended", seq: 1 });
    // A second writer that read the empty campaign is answered conflict — its round is NOT interleaved.
    expect(await store.appendRound("acme", "evc_1", round(1), 0)).toEqual({ kind: "conflict", expected: 0, actual: 1 });
    expect((await store.get("acme", "evc_1"))?.rounds).toHaveLength(1);
  });

  it("a closed campaign refuses appends as terminal, and a second close reads what won", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record());
    expect(await store.close("acme", "evc_1", "no_improvement", CLOSE, 0)).toEqual({ kind: "closed" });
    expect(await store.appendRound("acme", "evc_1", round(1), 0)).toEqual({
      kind: "terminal",
      state: "no_improvement",
    });
    expect(await store.close("acme", "evc_1", "adopted", { ...CLOSE }, 0)).toEqual({
      kind: "already",
      state: "no_improvement",
    });
  });

  it("a close whose gate answer was computed over a SHORTER trace is refused — the rounds are the settle's read-set", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record());
    // The settle read rounds=[] and computed its answer; a round lands in between.
    expect(await store.appendRound("acme", "evc_1", round(1), 0)).toEqual({ kind: "appended", seq: 1 });
    expect(await store.close("acme", "evc_1", "no_improvement", CLOSE, 0)).toEqual({
      kind: "conflict",
      expected: 0,
      actual: 1,
    });
    expect((await store.get("acme", "evc_1"))?.state).toBe("open"); // the stale answer closed nothing
  });

  it("another workspace's campaign reads as nonexistent", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record());
    expect(await store.get("rival", "evc_1")).toBeUndefined();
    expect(await store.appendRound("rival", "evc_1", round(1), 0)).toEqual({ kind: "absent" });
  });
});

describe("PgEvolutionCampaignStore — the guards live in the statement", () => {
  function fakeClient(rowsBySql: Array<{ match: string; rows: unknown[] }>) {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client: SqlClient = {
      async query<R>(text: string, params?: unknown[]) {
        calls.push({ text, params });
        const hit = rowsBySql.find((r) => text.includes(r.match));
        return { rows: (hit?.rows ?? []) as R[] };
      },
    };
    return { client, calls };
  }

  it("WRITES the owning team and FILTERS the list on it, in the statement (arch-review 82)", async () => {
    // The team axis was added to the record, the in-memory twin and every transport — and the Postgres half
    // had no test at all. Two halves can be wrong here in ways the twin cannot show: a column missing from
    // the INSERT (the campaign is stored unowned, so every team sees it) and a list built without the
    // predicate (filtered after the page, which lets one team's rows push everyone else's off it).
    //
    // Seen RED before the column reached the insert, observed:
    //   the owning team never reached the INSERT: expected [...] to contain 'team-a'
    const { client, calls } = fakeClient([]);
    const store = new PgEvolutionCampaignStore(client);

    await store.create(record({ id: "camp_t", teamId: "team-a" }));
    const insert = calls[0];
    expect(insert?.text, "the team column never reached the INSERT").toContain("team_id");
    expect(insert?.params, "the owning team never reached the INSERT").toContain("team-a");

    // …and a campaign with no team stores NULL rather than a string: unowned is a real state, not a gap.
    const { client: c2, calls: calls2 } = fakeClient([]);
    await new PgEvolutionCampaignStore(c2).create(record({ id: "camp_u" }));
    expect(calls2[0]?.params).toContain(null);

    // The ceiling is applied IN THE QUERY. `IS NULL OR = ANY` because an unowned row is the workspace's and
    // belongs on every caller's page.
    const { client: c3, calls: calls3 } = fakeClient([{ match: "SELECT *", rows: [] }]);
    await new PgEvolutionCampaignStore(c3).list("acme", ["team-b"]);
    expect(calls3[0]?.text, "the list page was not filtered by the caller's teams").toContain("team_id IS NULL");
    expect(calls3[0]?.params).toContain("acme");

    // No ceiling (an admin, or a deployment with no teams) reads the unfiltered statement — a query that
    // always carried the predicate would make `undefined` mean "sees nothing" instead of "nothing hidden".
    const { client: c4, calls: calls4 } = fakeClient([{ match: "SELECT *", rows: [] }]);
    await new PgEvolutionCampaignStore(c4).list("acme");
    expect(calls4[0]?.text).not.toContain("team_id IS NULL");
  });

  it("appendRound CASes on the round count and the open state IN THE WHERE, and reads the landed count back", async () => {
    const { client, calls } = fakeClient([{ match: "WITH upd AS", rows: [{ n: 3 }] }]);
    const store = new PgEvolutionCampaignStore(client);
    const outcome = await store.appendRound("acme", "evc_1", round(3), 2);
    expect(outcome).toEqual({ kind: "appended", seq: 3 });
    const sql = calls[0]?.text ?? "";
    expect(sql).toContain("state='open'");
    expect(sql).toContain("jsonb_array_length(rounds) = $5");
    expect(calls[0]?.params?.[4]).toBe(2);
  });

  it("a refused append reads back WHY — terminal vs conflict vs absent are three different answers", async () => {
    const { client } = fakeClient([
      { match: "WITH upd AS", rows: [] },
      { match: "SELECT state, jsonb_array_length", rows: [{ state: "adopted", n: 4 }] },
    ]);
    const store = new PgEvolutionCampaignStore(client);
    expect(await store.appendRound("acme", "evc_1", round(5), 4)).toEqual({ kind: "terminal", state: "adopted" });
  });

  it("close CASes on state='open' AND the round count IN THE WHERE — never a read-then-write", async () => {
    const { client, calls } = fakeClient([{ match: "WITH upd AS", rows: [{ id: "evc_1" }] }]);
    const store = new PgEvolutionCampaignStore(client);
    expect(await store.close("acme", "evc_1", "adopted", CLOSE, 3)).toEqual({ kind: "closed" });
    const sql = calls[0]?.text ?? "";
    expect(sql).toContain("state='open'");
    expect(sql).toContain("jsonb_array_length(rounds) = $6");
    expect(calls[0]?.params?.[5]).toBe(3);
  });

  it("a refused close tells a stale gate answer apart from a lost settle race", async () => {
    const { client } = fakeClient([
      { match: "WITH upd AS", rows: [] },
      { match: "SELECT state, jsonb_array_length", rows: [{ state: "open", n: 4 }] },
    ]);
    const store = new PgEvolutionCampaignStore(client);
    // Still open, but the rounds moved: the gate's answer is stale — conflict, not already.
    expect(await store.close("acme", "evc_1", "adopted", CLOSE, 3)).toEqual({
      kind: "conflict",
      expected: 3,
      actual: 4,
    });
  });

  it("the outbox insert rides the SAME statement as each CAS, gated on the write landing", async () => {
    const { client, calls } = fakeClient([{ match: "WITH upd AS", rows: [{ n: 1, id: "evc_1" }] }]);
    const store = new PgEvolutionCampaignStore(client);
    const ev: OutboxEvent = {
      id: "ev1",
      tenant: "acme",
      kind: "campaign.round_logged",
      subject: { type: "campaign", id: "evc_1" },
      payload: {},
      message: "round",
      createdAt: "2026-08-26T00:00:00.000Z",
    };
    await store.appendRound("acme", "evc_1", round(1), 0, [ev]);
    await store.close("acme", "evc_1", "adopted", CLOSE, 1, [{ ...ev, id: "ev2", kind: "campaign.closed" }]);
    const statements = calls.filter((c) => c.text.includes("WITH upd AS"));
    expect(statements).toHaveLength(2); // one statement per write — the fact cannot land without it, nor separately
    for (const call of statements) {
      expect(call.text).toContain("everdict_platform_events");
      expect(call.text).toContain("WHERE EXISTS (SELECT 1 FROM upd)");
    }
  });
});

describe("CampaignService — verdicts are derived and frame-checked, settlements carry the gate's answer", () => {
  const issues = {
    async get(_tenant: string, ref: string) {
      if (ref !== "iss_1") throw new NotFoundError("NOT_FOUND", { ref }, "issue not found");
      return { id: "iss_1" };
    },
  };
  const snapshots = new Map<string, CampaignSnapshot>();
  const diffCalls: Array<{ opts?: { minDelta?: number; fdrAlpha?: number; visibleTeams?: string[] } }> = [];
  const diffs = {
    async diffSnapshot(
      _tenant: string,
      _b: string,
      candidateId: string,
      opts?: { minDelta?: number; fdrAlpha?: number; visibleTeams?: string[] },
    ): Promise<CampaignSnapshot> {
      diffCalls.push({ ...(opts !== undefined ? { opts } : {}) });
      const snap = snapshots.get(candidateId);
      if (!snap) throw new NotFoundError("NOT_FOUND", { candidateId }, "scorecard not found");
      return snap;
    },
  };
  let n = 0;
  // Both halves, because the settlement writes through one and the authorization is read through the other
  // — a fixture that carries only the campaign half cannot see an adoption at all.
  const service = (store: EvolutionCampaignStore & AdoptionOperationStore) =>
    new CampaignService({
      store,
      operations: store,
      issues,
      diffs,
      newId: () => `id_${++n}`,
      now: () => "2026-08-26T02:00:00.000Z",
    });

  const trialCase = (caseId: string, delta: number, significant: boolean, trials = 5) => ({
    caseId,
    baselineRate: 0.2,
    baselineTrials: trials,
    candidateRate: 0.2 + delta,
    candidateTrials: trials,
    delta,
    z: 2,
    method: "fisher" as const,
    p: 0.01,
    significant,
  });
  const comparison = (over: Partial<CampaignComparison> = {}): CampaignComparison => ({
    comparability: "full",
    trials: {
      baseline: "b",
      candidate: "c",
      zThreshold: 1.96,
      minDelta: 0,
      cases: [trialCase("c1", 0.8, true), trialCase("c2", 0, false)],
    } as CampaignComparison["trials"],
    experiment: { held: ["execution_world"], confounds: [], unverified: [] },
    ...over,
  });
  const side = (version: string, judges?: string[]) => ({
    record: {
      harness: { id: "agent:everdict", version },
      // The sealed manifest a real scorecard carries — the digest of the spec that batch actually ran. A
      // fixture without it exercises the LABEL-ONLY path, which the gate now refuses unless the frame waived
      // it (arch-review 72 P1-medium), so leaving it out would measure the waiver rather than the settlement.
      manifest: { harness: { specDigest: `sha256:spec-${version}` } },
      ...(judges !== undefined ? { orchestration: { judges: judges.map((id) => ({ id })) } } : {}),
    },
  });
  const snapshot = (
    diff: CampaignComparison,
    over: Partial<Pick<CampaignSnapshot, "baseline" | "candidate">> = {},
  ): CampaignSnapshot => ({ diff, baseline: side("1.0.0"), candidate: side("1.0.1"), ...over });

  const LOG = {
    hypothesis: "shorter instructions",
    candidateVersion: "1.0.1",
    baselineScorecardId: "sc-base",
    candidateScorecardId: "sc-win",
  };

  it("open freezes the frame with a digest and journals into a REAL issue only", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    expect(rec.frameDigest).toMatch(/^sha256:/);
    expect(rec.state).toBe("open");
    await expect(svc.open("acme", { issueId: "iss_404", frame }, "alice")).rejects.toBeInstanceOf(NotFoundError);
    expect(store.outbox().map((e) => e.kind)).toEqual(["campaign.opened"]);
  });

  it("FREEZES the issue's team at open, and lists only what a caller may see (arch-review 76)", async () => {
    // A campaign drove a team-owned effect while carrying no team of its own, so the read surface could
    // only filter by tenant and the adopt mutation could only be gated by a workspace-level action — which
    // asks nothing about the resource it changes. The team is frozen from the ISSUE: the campaign journals
    // into it, so they cannot belong to different teams without one of them being a lie.
    //
    // Seen RED before the column existed, observed:
    //   a private team's campaign was listed to every member: expected 0 to be 1 (filtered length)
    const store = new InMemoryEvolutionCampaignStore();
    const teamed = new CampaignService({
      store,
      operations: store,
      issues: {
        async get(_t: string, ref: string) {
          return { id: ref, teamId: ref === "iss_a" ? "team-a" : "team-b" };
        },
      },
      diffs,
      newId: () => `camp_${Math.random().toString(36).slice(2, 8)}`,
      now: () => "2026-08-27T02:00:00.000Z",
    });

    const a = await teamed.open("acme", { issueId: "iss_a", frame }, "alice");
    const b = await teamed.open("acme", { issueId: "iss_b", frame }, "bob");
    expect(a.teamId, "the campaign did not inherit its issue's team").toBe("team-a");
    expect(b.teamId).toBe("team-b");

    // A ceiling of team-a sees only team-a's.
    const forA = await teamed.list("acme", ["team-a"]);
    expect(
      forA.map((c) => c.id),
      "a private team's campaign was listed to another team",
    ).toEqual([a.id]);
    // No ceiling (an admin, or a deployment with no teams) sees both.
    expect((await teamed.list("acme")).length).toBe(2);

    // …and a row with NO team is UNOWNED — the workspace's, visible to every ceiling. That is the legacy
    // row's honest reading, and it is why the column is nullable and not backfilled.
    await store.create({
      ...a,
      id: "camp-legacy-unowned",
      teamId: undefined,
    });
    expect((await teamed.list("acme", ["team-a"])).map((c) => c.id)).toContain("camp-legacy-unowned");
    expect((await teamed.list("acme", ["team-zzz"])).map((c) => c.id)).toEqual(["camp-legacy-unowned"]);
  });

  it("refuses an open whose issue moved after the caller was authorized (arch-review 115)", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    // ── THE TEAM THE TRANSPORT AUTHORIZED, ASSERTED WHERE IT IS STAMPED (arch-review 115) ─────────
    //
    // The route reads the issue to gate `scorecards:run` on its team and `open` reads the SAME issue again to
    // stamp the campaign's. `POST /issues/:id/team` between the two files a Team B campaign for a caller
    // cleared only for Team A — and every later gate on that campaign then answers for a team this caller was
    // never authorized over. Same law as the registry's `expectedOwnerTeamId`: an authorization and the effect
    // it authorizes read the mutable fact once.
    //
    // Seen RED without the check: the campaign was opened with `teamId: "team-b"`.
    const moving = new CampaignService({
      store,
      operations: store,
      issues: {
        // The transport read team-a; by the time `open` reads it, the issue has moved.
        async get(_t: string, ref: string) {
          return { id: ref, teamId: "team-b" };
        },
      },
      diffs,
      newId: () => `camp_${Math.random().toString(36).slice(2, 8)}`,
      now: () => "2026-08-27T02:00:00.000Z",
    });
    await expect(
      moving.open("acme", { issueId: "iss_a", frame, expectedIssueTeamId: "team-a" }, "alice"),
      "a caller cleared for team-a opened a team-b campaign",
    ).rejects.toBeInstanceOf(ConflictError);
    // …and a caller that stated no expectation is unaffected — headless and seeded opens still work.
    await expect(moving.open("acme", { issueId: "iss_a", frame }, "alice")).resolves.toMatchObject({
      teamId: "team-b",
    });
  });

  it("REFUSES to decide, log or settle on a frame that predates the current rules (arch-review 75)", async () => {
    // arch-review 72 split creation from storage so a legacy campaign stays READABLE. It left the other
    // half open: such a campaign is still `open`, and a fresh round logged after the upgrade builds a
    // heldOut block from the frame's single flag — manufacturing exactly the evidence the two-scenario rule
    // exists to require, and the gate then adopts on it.
    //
    // Seen RED before the eligibility guard, observed:
    //   legacy 1-held-out frame + new round → adopt ADOPTS v1.1.0
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    // Written directly, because `open` correctly refuses this frame — the row is one an older deployment
    // stored, which is the whole premise (a fixture that could open it would be testing nothing).
    const legacy = {
      id: "camp-legacy",
      tenant: "acme",
      issueId: "iss_1",
      frame: {
        ...frame,
        scenarios: [
          { id: "only-one", heldOut: true },
          { id: "train", heldOut: false },
        ],
      },
      frameDigest: "sha256:legacy",
      rounds: [],
      state: "open" as const,
      createdBy: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.create(legacy);

    // READ still works — that is the availability half arch-review 72 bought, and it stays bought.
    expect((await svc.get("acme", "camp-legacy")).id).toBe("camp-legacy");
    expect((await svc.list("acme")).map((c) => c.id)).toContain("camp-legacy");

    // …and every path that produces or consumes NEW adoption evidence refuses, naming the remedy.
    await expect(svc.decision("acme", "camp-legacy"), "a legacy frame decided").rejects.toThrow(
      /predates the current adoption rules/,
    );
    await expect(
      svc.logRound(
        "acme",
        "camp-legacy",
        {
          hypothesis: "h",
          candidateVersion: "1.0.1",
          baselineScorecardId: "sc-b",
          candidateScorecardId: "sc-c",
        },
        "alice",
        {},
      ),
      "a legacy frame manufactured a held-out block",
    ).rejects.toThrow(/predates the current adoption rules/);
    await expect(svc.settle("acme", "camp-legacy", "alice")).rejects.toThrow(/predates the current adoption rules/);
    // Nothing was written by any of the three.
    expect((await svc.get("acme", "camp-legacy")).rounds).toHaveLength(0);
    expect((await svc.get("acme", "camp-legacy")).state).toBe("open");
  });

  it("a round's verdict comes from the diff — the caller cannot write its own report card", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    const { round: logged, answer } = await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
    expect(logged.verdict).toEqual({
      comparable: true,
      significantImprovements: 1,
      significantRegressions: 0,
      // The population adoption authority actually reads (arch-review 71 P1-high). Both scenarios in this
      // frame are held out, so the one significant improvement is a held-out one — which is why the gate
      // below still answers `adopt`. On a training-only improvement it would answer `continue`.
      heldOut: { improvements: 1, regressions: 0 },
      // The bytes this round actually evaluated, taken from the candidate scorecard's sealed manifest — the
      // join an adoption is checked against (arch-review 71 P0 / 72 P1-medium).
      candidateSpecDigest: "sha256:spec-1.0.1",
      unverifiedAxes: [],
      confoundedAxes: [],
    });
    expect(answer.kind).toBe("adopt");
  });

  it("the frame's FROZEN significance reaches the diff, and the caller's team ceiling rides along", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const strict: CampaignFrame = {
      ...frame,
      significance: { minDelta: 0.1, fdrAlpha: 0.05, heldOutFamilySize: 5 },
    };
    const rec = await svc.open("acme", { issueId: "iss_1", frame: strict }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    diffCalls.length = 0;
    await svc.logRound("acme", rec.id, LOG, "agent:everdict", { visibleTeams: ["team-a"] });
    // …divided by the pre-registered held-out family: 0.05 over 5 rounds is 0.01 a round.
    expect(diffCalls[0]?.opts).toEqual({ minDelta: 0.1, fdrAlpha: 0.01, visibleTeams: ["team-a"] });
  });

  // ── THE HELD-OUT SET IS TESTED ONCE PER ROUND AND NOTHING WAS COUNTING (counterexample) ──────────
  //
  // `fdrAlpha` corrects across the CASES of one round — the only family `diffTrials` can see. The campaign
  // asks a second family it cannot: the same frozen held-out population, once per round, any single round
  // able to end the walk by adopting. With three held-out cases at alpha 0.05, a null candidate wins a given
  // round with probability around H x alpha/2, so a ten-round campaign adopted noise about half the time —
  // and `budget.maxRounds` bounded the SPENDING, which is not a statement about what the answer means.
  //
  // Seen RED before the frame carried a family, observed:
  //   expected { minDelta: 0.1, fdrAlpha: 0.05, … } to deeply equal { …, fdrAlpha: 0.01, … }
  //
  // The division lives at the ONE seam that derives a verdict, from a size frozen at open — never at the
  // gate, which reads rounds already recorded and would be applying a level chosen after they ran.
  it("[COUNTEREXAMPLE] the round is judged at the frame's level divided by the pre-registered family", async () => {
    // maxRounds rides along because the family may never be smaller than the rounds it must cover — a
    // campaign correcting for fewer tests than it is allowed to run has not corrected.
    const run = async (heldOutFamilySize: number, maxRounds = heldOutFamilySize): Promise<number | undefined> => {
      const svc = service(new InMemoryEvolutionCampaignStore());
      const framed: CampaignFrame = {
        ...frame,
        budget: { maxRounds },
        significance: { fdrAlpha: 0.05, heldOutFamilySize },
      };
      const rec = await svc.open("acme", { issueId: "iss_1", frame: framed }, "alice");
      snapshots.set("sc-win", snapshot(comparison()));
      diffCalls.length = 0;
      await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
      return diffCalls[0]?.opts?.fdrAlpha;
    };
    // A campaign that plans twice the rounds spends half the alpha on each — the whole point, and the cost.
    expect(await run(5)).toBeCloseTo(0.01, 12);
    expect(await run(10)).toBeCloseTo(0.005, 12);
    // …and a family of one IS the old behaviour, which is why it is a declaration rather than a default:
    // a campaign may say "one look" out loud, and then it may only take one.
    expect(await run(1)).toBeCloseTo(0.05, 12);
  });

  it("a round whose scorecards evaluated something else is REFUSED, never recorded", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    // Candidate scorecard actually ran 1.0.0 — the declared 1.0.1 would name a graduate nobody examined.
    snapshots.set("sc-win", snapshot(comparison(), { candidate: side("1.0.0") }));
    await expect(svc.logRound("acme", rec.id, LOG, "agent:everdict", {})).rejects.toBeInstanceOf(BadRequestError);
    // Wrong subject entirely.
    snapshots.set("sc-win", {
      diff: comparison(),
      baseline: { record: { harness: { id: "other-agent", version: "1.0.0" } } },
      candidate: { record: { harness: { id: "other-agent", version: "1.0.1" } } },
    });
    await expect(svc.logRound("acme", rec.id, LOG, "agent:everdict", {})).rejects.toBeInstanceOf(BadRequestError);
    // Baseline drifted off the frame's baseline version.
    snapshots.set("sc-win", snapshot(comparison(), { baseline: side("1.0.9") }));
    await expect(svc.logRound("acme", rec.id, LOG, "agent:everdict", {})).rejects.toBeInstanceOf(BadRequestError);
    expect((await svc.get("acme", rec.id)).rounds).toHaveLength(0); // nothing was logged
  });

  it("a run that drifted off the frame's scenarios or trials is a rejected round with the drift named", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    // Only the easy scenario ran — the frame's c2 (held out) is missing.
    snapshots.set(
      "sc-win",
      snapshot(
        comparison({
          trials: {
            baseline: "b",
            candidate: "c",
            zThreshold: 1.96,
            minDelta: 0,
            cases: [trialCase("c1", 0.8, true)],
          } as CampaignComparison["trials"],
        }),
      ),
    );
    const easy = await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
    expect(easy.round.verdict.comparable).toBe(false);
    expect(easy.round.verdict.detail).toContain("missing: c2");
    // Thin trials: the frame demands 5.
    snapshots.set(
      "sc-win",
      snapshot(
        comparison({
          trials: {
            baseline: "b",
            candidate: "c",
            zThreshold: 1.96,
            minDelta: 0,
            cases: [trialCase("c1", 0.8, true, 2), trialCase("c2", 0, false, 2)],
          } as CampaignComparison["trials"],
        }),
      ),
    );
    const thin = await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
    expect(thin.round.verdict.comparable).toBe(false);
    expect(thin.round.verdict.detail).toContain("fewer than the frame's 5 trials");
  });

  it("a frame that froze judges rejects a round judged by anyone else", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const judged: CampaignFrame = { ...frame, judges: ["drill-structure"] };
    const rec = await svc.open("acme", { issueId: "iss_1", frame: judged }, "alice");
    snapshots.set("sc-win", {
      diff: comparison(),
      baseline: side("1.0.0", ["other-judge"]),
      candidate: side("1.0.1", ["other-judge"]),
    });
    const wrong = await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
    expect(wrong.round.verdict.comparable).toBe(false);
    expect(wrong.round.verdict.detail).toContain("judges are not the frame's");
  });

  it("an axis VERIFIED different is a confound — recorded, non-comparable, and never waivable", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    // Even with the unverified-identity waiver on, a confound refuses: it is measured difference, not doubt.
    const waived: CampaignFrame = { ...frame, allowUnverifiedIdentity: true };
    const rec = await svc.open("acme", { issueId: "iss_1", frame: waived }, "alice");
    snapshots.set(
      "sc-win",
      snapshot(
        comparison({
          experiment: {
            held: [],
            confounds: [{ axis: "execution_world", detail: "resolved to different image digests" }],
            unverified: [],
          },
        }),
      ),
    );
    const { round: logged, answer } = await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
    expect(logged.verdict.comparable).toBe(false);
    expect(logged.verdict.confoundedAxes).toEqual(["execution_world"]);
    expect(logged.verdict.detail).toContain("confounded");
    expect(answer.kind).toBe("continue"); // a confounded win adopts nothing
  });

  it("an unverified world identity on the winning round refuses the settle and keeps the campaign open", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set(
      "sc-unv",
      snapshot(
        comparison({
          experiment: {
            held: [],
            confounds: [],
            unverified: [{ axis: "execution_world", reason: "unresolved", detail: "unpinned tag" }],
          },
        }),
      ),
    );
    await svc.logRound("acme", rec.id, { ...LOG, candidateScorecardId: "sc-unv" }, "agent:everdict", {});
    await expect(svc.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
    expect((await svc.get("acme", rec.id)).state).toBe("open");
  });

  it("leaves a DECIDED adoption operation the registry write must spend (arch-review 71 P0)", async () => {
    // The production path, end to end: the service settles, and the authorization the close owes is there
    // for a registry write to present. Before this, `adopted` was a decision with no effect and no debt —
    // a settle followed by a crash left a campaign claiming adoption with no capability anywhere.
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
    await svc.settle("acme", rec.id, "alice");

    const op = await store.forCampaign("acme", rec.id);
    expect(op, "the service settled adopted and authorized nothing").toBeDefined();
    expect(op?.state).toBe("decided");
    expect(op?.proof.campaignId).toBe(rec.id);
    expect(op?.proof.issueId, "the authorization lost the intent it was opened against").toBe("iss_1");
  });

  it("settle on an adoptable latest closes as adopted with the proving scorecard and the fact", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
    const { record: settled, answer } = await svc.settle("acme", rec.id, "alice");
    expect(answer).toEqual({
      kind: "adopt",
      version: "1.0.1",
      provingScorecardId: "sc-win",
      waivedAxes: [],
      candidateSpecDigest: "sha256:spec-1.0.1",
    });
    expect(settled.state).toBe("adopted");
    expect(store.outbox().map((e) => e.kind)).toEqual(["campaign.opened", "campaign.round_logged", "campaign.closed"]);
    await expect(svc.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
  });

  // ── A CHAIN IS ONE EXAM SPENT ACROSS SEVERAL CAMPAIGNS (counterexample) ──────────────────────────
  //
  // The family correction bounds the tests ONE campaign spends against its frozen held-out rows. "Keep
  // improving" means opening another campaign from what this one adopted — against the SAME held-out rows —
  // and a per-campaign family cannot see those tests at all. So a walk of five 5-round campaigns spends 25
  // tests against a population each frame corrected for 5, and the correction leaks straight back out
  // through the thing it exists to make honest.
  //
  // Seen RED before `continues` was verified, observed:
  //   a successor budgeting 5 more rounds over a family of 5 with 1 already spent OPENED, and its rounds
  //   were judged at 0.01 as though nothing had been asked of those rows before.
  //
  // The refusal is at OPEN because that is the only moment it can change anything: afterwards the frame is
  // frozen and its rounds are judged at a level nobody may revise.
  describe("continuing a campaign", () => {
    const adoptedPredecessor = async (store: InMemoryEvolutionCampaignStore) => {
      const svc = service(store);
      const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      snapshots.set("sc-win", snapshot(comparison()));
      await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
      await svc.settle("acme", rec.id, "alice"); // adopts 1.0.1, one round spent
      return { svc, id: rec.id };
    };
    // Everything a successor must agree with its predecessor about, with the budget left to spend.
    const successor = (id: string, over: Partial<CampaignFrame> = {}): CampaignFrame => ({
      ...frame,
      continues: id,
      subject: { ...frame.subject, baselineVersion: "1.0.1" },
      budget: { maxRounds: 4 }, // 1 spent + 4 = the pre-registered family of 5
      ...over,
    });

    it("opens when the chain still fits inside the family it pre-registered", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store);
      const next = await svc.open("acme", { issueId: "iss_1", frame: successor(id) }, "alice");
      expect(next.frame.continues).toBe(id);
      // …and the link rides the DIGEST, so a chain claim cannot be edited after the fact.
      expect(next.frameDigest).not.toBe((await svc.get("acme", id)).frameDigest);
    });

    it("[COUNTEREXAMPLE] REFUSES a successor whose rounds would overspend the shared family", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store);
      // Five more rounds against rows already asked once, under a family pre-registered for five in total.
      const over = successor(id, { budget: { maxRounds: 5 } });
      await expect(svc.open("acme", { issueId: "iss_1", frame: over }, "alice")).rejects.toThrow(
        /spent 1 of its 5 pre-registered held-out tests/,
      );
    });

    it("refuses a predecessor that proved nothing to continue from", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const svc = service(store);
      const open = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
      await expect(svc.open("acme", { issueId: "iss_1", frame: successor(open.id) }, "alice")).rejects.toBeInstanceOf(
        ConflictError,
      );
      // …and a chain naming a campaign that does not exist refuses with the read, never by opening.
      await expect(
        svc.open("acme", { issueId: "iss_1", frame: successor("evc_ghost") }, "alice"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses a chain that starts somewhere other than what its predecessor proved", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store);
      const drifted = successor(id, { subject: { ...frame.subject, baselineVersion: "9.9.9" } });
      await expect(svc.open("acme", { issueId: "iss_1", frame: drifted }, "alice")).rejects.toThrow(
        /a chain starts from what its predecessor proved/,
      );
    });

    it("refuses a chain over DIFFERENT held-out rows — that is another exam, and its tests do not carry", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store);
      const otherExam = successor(id, {
        scenarios: [
          { id: "c1", heldOut: true },
          { id: "c3", heldOut: true },
        ],
      });
      await expect(svc.open("acme", { issueId: "iss_1", frame: otherExam }, "alice")).rejects.toThrow(/different exam/);
    });

    it("refuses a chain that re-declares its statistics — one walk, one pre-registration", async () => {
      const store = new InMemoryEvolutionCampaignStore();
      const { svc, id } = await adoptedPredecessor(store);
      // A looser level, or a bigger family, chosen AFTER seeing the predecessor's rounds. Either is a rule
      // picked with the data in hand, which is what freezing a frame exists to prevent.
      const relaxed = successor(id, { significance: { fdrAlpha: 0.05, heldOutFamilySize: 50 } });
      await expect(svc.open("acme", { issueId: "iss_1", frame: relaxed }, "alice")).rejects.toThrow(
        /a chain shares one pre-registration/,
      );
    });
  });

  it("a round landing between the gate's read and the close makes the settle CONFLICT — the answer was stale", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
    // A concurrent loop logs round 2 AFTER the settle computed its answer over 1 round — modeled by a store
    // wrapper that interleaves the append between the settle's read and its close.
    const raced: EvolutionCampaignStore & AdoptionOperationStore = {
      create: store.create.bind(store),
      get: store.get.bind(store),
      list: store.list.bind(store),
      appendRound: store.appendRound.bind(store),
      // FORWARDS THE ADOPTION RIDER. A double that drops it would make this file green over exactly the
      // defect arch-review 71 found one seam over — a forwarder that carries some riders and not others.
      close: async (tenant, id, state, close, expectedRounds, events, adoption) => {
        await store.appendRound(tenant, id, round(2, { significantImprovements: 1 }), 1);
        return store.close(tenant, id, state, close, expectedRounds, events, adoption);
      },
      forCampaign: store.forCampaign.bind(store),
      markRegistered: store.markRegistered.bind(store),
      forIssue: store.forIssue.bind(store),
      markCompleted: store.markCompleted.bind(store),
      registeredOlderThan: store.registeredOlderThan.bind(store),
      // The real store's own answer, not `true`: `deferCompletion` is a conditional write (rule `testing`).
      deferCompletion: store.deferCompletion.bind(store),
    };
    const svc2 = new CampaignService({
      store: raced,
      operations: raced,
      issues,
      diffs,
      newId: () => "x",
      now: () => "t",
    });
    await expect(svc2.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
    const after = await svc2.get("acme", rec.id);
    expect(after.state).toBe("open"); // the stale adopt never landed
    expect(after.rounds).toHaveLength(2);
  });

  it("a gate that answers continue refuses the settle — a campaign cannot be closed out from under its loop", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    await expect(svc.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
  });

  it("a non-comparable pair is recorded as a rejected round, never a win", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-bad", snapshot(comparison({ comparability: "none" })));
    const { round: logged } = await svc.logRound(
      "acme",
      rec.id,
      { ...LOG, candidateScorecardId: "sc-bad" },
      "agent:everdict",
      {},
    );
    expect(logged.verdict.comparable).toBe(false);
    expect((await svc.decision("acme", rec.id)).kind).toBe("continue");
  });
});
