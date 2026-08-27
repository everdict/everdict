import {
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
  significance: {},
  allowUnverifiedIdentity: false,
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
  const service = (store: EvolutionCampaignStore) =>
    new CampaignService({
      store,
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
      unverifiedAxes: [],
      confoundedAxes: [],
    });
    expect(answer.kind).toBe("adopt");
  });

  it("the frame's FROZEN significance reaches the diff, and the caller's team ceiling rides along", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const strict: CampaignFrame = { ...frame, significance: { minDelta: 0.1, fdrAlpha: 0.05 } };
    const rec = await svc.open("acme", { issueId: "iss_1", frame: strict }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    diffCalls.length = 0;
    await svc.logRound("acme", rec.id, LOG, "agent:everdict", { visibleTeams: ["team-a"] });
    expect(diffCalls[0]?.opts).toEqual({ minDelta: 0.1, fdrAlpha: 0.05, visibleTeams: ["team-a"] });
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
    expect(answer).toEqual({ kind: "adopt", version: "1.0.1", provingScorecardId: "sc-win", waivedAxes: [] });
    expect(settled.state).toBe("adopted");
    expect(store.outbox().map((e) => e.kind)).toEqual(["campaign.opened", "campaign.round_logged", "campaign.closed"]);
    await expect(svc.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
  });

  it("a round landing between the gate's read and the close makes the settle CONFLICT — the answer was stale", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    snapshots.set("sc-win", snapshot(comparison()));
    await svc.logRound("acme", rec.id, LOG, "agent:everdict", {});
    // A concurrent loop logs round 2 AFTER the settle computed its answer over 1 round — modeled by a store
    // wrapper that interleaves the append between the settle's read and its close.
    const raced: EvolutionCampaignStore = {
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
    };
    const svc2 = new CampaignService({ store: raced, issues, diffs, newId: () => "x", now: () => "t" });
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
