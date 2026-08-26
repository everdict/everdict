import { type CampaignComparison, CampaignService, type EvolutionCampaignStore } from "@everdict/application-control";
import type { CampaignFrame, CampaignRound, EvolutionCampaignRecord } from "@everdict/contracts";
import { ConflictError, NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryEvolutionCampaignStore, PgEvolutionCampaignStore } from "./campaign-store.js";

// ── The campaign settlement: store guards + the service's derived verdicts (Track D) ─────────────────
//
// The in-memory twin makes the SAME decisions as Postgres (the append CAS, the open-only close), so these
// units exercise the refusals production would give; the Pg half is additionally pinned at the SQL layer
// (fake SqlClient — the statement must CAS in the WHERE, not in a read-then-write).

const frame: CampaignFrame = {
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "s1", heldOut: false },
    { id: "s2", heldOut: true },
  ],
  judges: ["drill-structure"],
  trialsPerCase: 5,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  significance: {},
  allowUnverifiedIdentity: false,
};

const round = (seq: number, over: Partial<CampaignRound["verdict"]> = {}): CampaignRound => ({
  seq,
  hypothesis: "structure over phrasing",
  candidateVersion: `1.0.${seq}`,
  baselineScorecardId: "sc-base",
  candidateScorecardId: `sc-cand-${seq}`,
  verdict: { comparable: true, significantImprovements: 0, significantRegressions: 0, unverifiedAxes: [], ...over },
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
    const close = {
      outcome: { kind: "halted" as const, reason: "no_improvement" as const, detail: "dry" },
      at: "2026-08-26T01:00:00.000Z",
      by: "alice",
    };
    expect(await store.close("acme", "evc_1", "no_improvement", close)).toEqual({ kind: "closed" });
    expect(await store.appendRound("acme", "evc_1", round(1), 0)).toEqual({
      kind: "terminal",
      state: "no_improvement",
    });
    expect(await store.close("acme", "evc_1", "adopted", { ...close })).toEqual({
      kind: "already",
      state: "no_improvement",
    });
  });

  it("another workspace's campaign reads as nonexistent", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record());
    expect(await store.get("rival", "evc_1")).toBeUndefined();
    expect(await store.appendRound("rival", "evc_1", round(1), 0)).toEqual({ kind: "absent" });
  });
});

describe("PgEvolutionCampaignStore — the CAS lives in the statement", () => {
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

  it("the outbox insert rides the SAME statement as the CAS, gated on the update landing", async () => {
    const { client, calls } = fakeClient([{ match: "WITH upd AS", rows: [{ n: 1 }] }]);
    const store = new PgEvolutionCampaignStore(client);
    await store.appendRound("acme", "evc_1", round(1), 0, [
      {
        id: "ev1",
        tenant: "acme",
        kind: "campaign.round_logged",
        subject: { type: "campaign", id: "evc_1" },
        payload: {},
        message: "round",
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ]);
    const sql = calls[0]?.text ?? "";
    expect(sql).toContain("everdict_platform_events");
    expect(sql).toContain("WHERE EXISTS (SELECT 1 FROM upd)");
    expect(calls).toHaveLength(1); // one statement — the fact cannot land without the round, nor separately
  });
});

describe("CampaignService — verdicts are derived, settlements carry the gate's answer", () => {
  const issues = {
    async get(_tenant: string, ref: string) {
      if (ref !== "iss_1") throw new NotFoundError("NOT_FOUND", { ref }, "issue not found");
      return { id: "iss_1" };
    },
  };
  const comparisons = new Map<string, CampaignComparison>();
  const diffs = {
    async diff(_tenant: string, _b: string, candidateId: string): Promise<CampaignComparison> {
      const cmp = comparisons.get(candidateId);
      if (!cmp) throw new NotFoundError("NOT_FOUND", { candidateId }, "scorecard not found");
      return cmp;
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

  const trialCase = (delta: number, significant: boolean) => ({
    caseId: "c1",
    baselineRate: 0.2,
    baselineTrials: 5,
    candidateRate: 0.2 + delta,
    candidateTrials: 5,
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
      cases: [trialCase(0.8, true)],
    } as CampaignComparison["trials"],
    experiment: { held: ["execution_world"], confounds: [], unverified: [] },
    ...over,
  });

  it("open freezes the frame with a digest and journals into a REAL issue only", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    expect(rec.frameDigest).toMatch(/^sha256:/);
    expect(rec.state).toBe("open");
    await expect(svc.open("acme", { issueId: "iss_404", frame }, "alice")).rejects.toBeInstanceOf(NotFoundError);
    // The opened fact rode the create.
    expect(store.outbox().map((e) => e.kind)).toEqual(["campaign.opened"]);
  });

  it("a round's verdict comes from the diff — the caller cannot write its own report card", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    comparisons.set("sc-win", comparison());
    const { round: logged, answer } = await svc.logRound(
      "acme",
      rec.id,
      {
        hypothesis: "shorter instructions",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-base",
        candidateScorecardId: "sc-win",
      },
      "agent:everdict",
    );
    expect(logged.verdict).toEqual({
      comparable: true,
      significantImprovements: 1,
      significantRegressions: 0,
      unverifiedAxes: [],
    });
    expect(answer.kind).toBe("adopt");
  });

  it("an unverified world identity on the winning round refuses the settle and keeps the campaign open", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    comparisons.set(
      "sc-unv",
      comparison({
        experiment: {
          held: [],
          confounds: [],
          unverified: [{ axis: "execution_world", reason: "unresolved", detail: "unpinned tag" }],
        },
      }),
    );
    await svc.logRound(
      "acme",
      rec.id,
      {
        hypothesis: "h",
        candidateVersion: "1.0.1",
        baselineScorecardId: "sc-base",
        candidateScorecardId: "sc-unv",
      },
      "agent:everdict",
    );
    await expect(svc.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
    expect((await svc.get("acme", rec.id)).state).toBe("open");
  });

  it("settle on an adoptable latest closes as adopted with the proving scorecard and the fact", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    const svc = service(store);
    const rec = await svc.open("acme", { issueId: "iss_1", frame }, "alice");
    comparisons.set("sc-win", comparison());
    await svc.logRound(
      "acme",
      rec.id,
      { hypothesis: "h", candidateVersion: "1.0.1", baselineScorecardId: "sc-base", candidateScorecardId: "sc-win" },
      "agent:everdict",
    );
    const { record: settled, answer } = await svc.settle("acme", rec.id, "alice");
    expect(answer).toEqual({ kind: "adopt", version: "1.0.1", provingScorecardId: "sc-win", waivedAxes: [] });
    expect(settled.state).toBe("adopted");
    expect(settled.close?.outcome).toMatchObject({ kind: "adopted", version: "1.0.1", provingScorecardId: "sc-win" });
    expect(store.outbox().map((e) => e.kind)).toEqual(["campaign.opened", "campaign.round_logged", "campaign.closed"]);
    // …and the settle is one-shot: the second answer reads what won.
    await expect(svc.settle("acme", rec.id, "alice")).rejects.toBeInstanceOf(ConflictError);
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
    comparisons.set("sc-bad", comparison({ comparability: "none" }));
    const { round: logged } = await svc.logRound(
      "acme",
      rec.id,
      { hypothesis: "h", candidateVersion: "1.0.1", baselineScorecardId: "sc-base", candidateScorecardId: "sc-bad" },
      "agent:everdict",
    );
    expect(logged.verdict.comparable).toBe(false);
    expect((await svc.decision("acme", rec.id)).kind).toBe("continue");
  });
});
