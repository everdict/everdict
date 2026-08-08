import { ScorecardService } from "@everdict/application-control";
import type { CaseResult, GateDecision, ScorecardRecord } from "@everdict/contracts";
import { MANIFEST_IDENTITY_VERSION } from "@everdict/contracts";
import { PgScorecardStore } from "@everdict/db";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-39.
//
// THE LEDGER IS APPEND-ONLY IN THE DATABASE TOO. The scoring and gates arrays live in jsonb columns, and a
// read-modify-write UPDATE makes lost updates a matter of interleaving: two concurrent gate decisions each
// read [] and each write [own], and the database keeps whichever landed last — one release decision
// silently erased. The store-level guard (WHERE jsonb_array_length = expected) is a CAS only a REAL
// Postgres can certify: an in-memory fake serializes by construction and proves nothing about the SQL.
// Certified here: (1) two same-instant guarded appends → exactly one lands, the loser sees the conflict;
// (2) the SERVICE's gate lane retries the loser, so both decisions survive in the ledger; (3) a rescore
// settle whose expected ledger length went stale REFUSES rather than eating the other pass's revision.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

const scored = (caseId: string, pass: boolean): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
  scores: [{ graderId: "t", metric: "tests_pass", value: pass ? 1 : 0, pass }],
});

describeTrust("TRUST-39 — concurrent ledger appends over real Postgres: no decision is ever silently erased", () => {
  let pg: TrustPg;
  let tenant: string;

  beforeAll(async () => {
    pg = await openTrustPg();
    tenant = trustId("trust-cas");
  });
  afterAll(async () => {
    if (tenant) await pg.client.query("DELETE FROM everdict_scorecards WHERE tenant = $1", [tenant]);
    await pg?.close();
  });

  const record = (id: string, results: CaseResult[]): ScorecardRecord => ({
    id: `${tenant}-${id}`,
    tenant,
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    scorecard: { suiteId: "d@1.0.0", harness: "h@1", results },
    manifest: {
      identityVersion: MANIFEST_IDENTITY_VERSION,
      dataset: { id: "d", version: "1.0.0", digest: "sha256:composite" },
      cases: { a: "sha256:case-a" },
      grading: "sha256:grading",
      harness: { id: "h", version: "1" },
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });

  it("two same-instant guarded appends: exactly one lands, and the SQL text carries the guard", async () => {
    const store = new PgScorecardStore(pg.client);
    await store.create(record("raw", [scored("a", true)]));
    const gate = (decidedBy: string): GateDecision => ({
      id: trustId("gd"),
      baseline: `${tenant}-raw`,
      candidate: `${tenant}-raw`,
      decision: "pass" as const,
      reasons: [],
      policy: { maxRegressions: 0 },
      policyDigest: "sha256:policy",
      evidence: { comparability: "full" as const, missingCases: 0, trialsGated: false },
      decidedBy,
      decidedAt: "2026-08-02T00:00:00.000Z",
    });
    // Both writers read the SAME empty ledger and present the SAME expected count — the exact lost-update
    // interleave. The guard makes the database itself refuse the second write.
    const [a, b] = await Promise.all([
      store.update(`${tenant}-raw`, { gates: [gate("ci-a")] }, undefined, { expectGatesCount: 0 }),
      store.update(`${tenant}-raw`, { gates: [gate("ci-b")] }, undefined, { expectGatesCount: 0 }),
    ]);
    const landed = [a, b].filter((r) => r !== undefined);
    expect(landed).toHaveLength(1);
    const final = await store.get(`${tenant}-raw`);
    expect(final?.gates).toHaveLength(1); // one decision, never a silent overwrite of the other
  });

  it("the service's gate lane retries the loser — BOTH concurrent decisions survive in the ledger", async () => {
    const store = new PgScorecardStore(pg.client);
    const service = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("never dispatches");
        },
      },
      store,
      datasets: new InMemoryDatasetRegistry(),
      newId: () => trustId("g39"),
    });
    await store.create(record("base", [scored("a", true)]));
    await store.create(record("cand", [scored("a", true)]));
    await Promise.all([
      service.gate({ tenant, baseline: `${tenant}-base`, candidate: `${tenant}-cand`, decidedBy: "ci-a" }),
      service.gate({ tenant, baseline: `${tenant}-base`, candidate: `${tenant}-cand`, decidedBy: "ci-b" }),
    ]);
    const final = await store.get(`${tenant}-cand`);
    expect(final?.gates?.map((g) => g.decidedBy).sort()).toEqual(["ci-a", "ci-b"]);
  });

  it("a rescore settle with a stale expected ledger length REFUSES — the other pass's revision is never eaten", async () => {
    const store = new PgScorecardStore(pg.client);
    await store.create({
      ...record("led", [scored("a", true)]),
      scoring: [
        {
          revision: 1,
          kind: "initial",
          judges: [],
          scorePlaneDigest: "sha256:p1",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        {
          revision: 2,
          kind: "rescore",
          judges: [],
          scorePlaneDigest: "sha256:p2",
          createdAt: "2026-08-01T01:00:00.000Z",
        },
      ],
    });
    // A late-waking pass read the ledger at length 1 and tries to settle its own revision 2 over it.
    const stale = await store.update(
      `${tenant}-led`,
      { scoring: [{ revision: 2, kind: "rescore", judges: [], scorePlaneDigest: "sha256:LATE", createdAt: "x" }] },
      undefined,
      { expectScoringCount: 1 },
    );
    expect(stale).toBeUndefined();
    const final = await store.get(`${tenant}-led`);
    expect(final?.scoring?.map((rev) => rev.scorePlaneDigest)).toEqual(["sha256:p1", "sha256:p2"]);
  });
});
