import { ProductService } from "@everdict/application-control";
import type { CaseResult, ProductSeries, ScorecardRecord } from "@everdict/contracts";
import { MANIFEST_IDENTITY_VERSION } from "@everdict/contracts";
import { PgIssueStore, PgProductStore, PgProductVersionStore, PgReleaseStore, PgScorecardStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-121.
//
// EVERY MUTABLE INPUT THAT COMPOSED A DECISION IS THAT DECISION'S READ-SET. A terminal transition that CASes
// only part of it is an atomic WRITE, not an atomic DECISION.
//
// Release readiness reads three mutable things: the open issues linked to the release, the newest succeeded
// scorecard per watched series, and each series' current evaluation contract. Two of them lived on rows that
// nothing fenced — so a ship could commit a history entry stating `openIssues: 0, force: false` while an open
// issue existed before its linearization point, or ship against S10 after S11 had already landed. The
// recorded scoring pin says WHICH judgment was read; it cannot say "and it was still the latest".
//
// The product's policy and definition were fenced two waves ago, which is exactly why the rest had to be:
// once a decision commits under write-time linearization for one of its inputs, treating the others as
// read-time snapshots is not a smaller guarantee, it is an inconsistent one.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-121 — a ship CASes the whole decision, not the convenient half", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => pg?.close());

  const scored = (caseId: string, pass: boolean): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores: [{ graderId: "t", metric: "tests_pass", value: pass ? 1 : 0, pass }],
  });

  const seriesBatch = (id: string, productId: string, createdAt: string, results: CaseResult[]): ScorecardRecord =>
    ({
      id,
      tenant: "trust",
      dataset: { id: "support-cases", version: "1.0.0" },
      harness: { id: "copilot", version: "1.0.0" },
      status: "succeeded",
      scorecard: { suiteId: "support-cases@1.0.0", harness: "copilot@1.0.0", results },
      summary: [
        {
          metric: "tests_pass",
          count: results.length,
          passRate:
            results.filter((r) => r.scores[0] && "pass" in r.scores[0] && r.scores[0].pass).length / results.length,
        },
      ],
      manifest: {
        identityVersion: MANIFEST_IDENTITY_VERSION,
        dataset: { id: "support-cases", version: "1.0.0", digest: "sha256:composite" },
        cases: { a: "sha256:case-a", b: "sha256:case-b" },
        grading: "sha256:grading",
        harness: { id: "copilot", version: "1.0.0" },
      },
      origin: { source: "product", productId, seriesKey: "quality" },
      createdAt,
      updatedAt: createdAt,
    }) as ScorecardRecord;

  const SERIES: ProductSeries = {
    key: "quality",
    label: "Quality",
    dataset: { id: "support-cases" },
    harness: { id: "copilot" },
    judges: [],
    allowNoBaseline: true,
  };

  // The interleaving, made exact: the concurrent write lands AFTER readiness has been computed and BEFORE the
  // release row is updated. Mutating before the call would only prove the domain's own gate — the decision
  // would read the new state and refuse for the ordinary reason, certifying nothing about the fence.
  class RacingReleaseStore extends PgReleaseStore {
    private race?: () => Promise<void>;
    onNextWrite(race: () => Promise<void>): void {
      this.race = race;
    }
    override async update(...args: Parameters<PgReleaseStore["update"]>): ReturnType<PgReleaseStore["update"]> {
      const race = this.race;
      this.race = undefined;
      if (race) await race();
      return super.update(...args);
    }
  }

  async function world() {
    const products = new PgProductStore(pg.client);
    const releases = new RacingReleaseStore(pg.client);
    const scorecards = new PgScorecardStore(pg.client);
    // A REAL issue store — the fence is a subquery over `everdict_issues`, so an in-memory twin beside a Pg
    // release store would count zero rows and pass the guard while proving nothing.
    const issues = new PgIssueStore(pg.client);
    let n = 0;
    const prefix = trustId("t121");
    const service = new ProductService({
      store: products,
      releases,
      versions: new PgProductVersionStore(pg.client),
      issues,
      scorecards,
      // The gate is not what these scenarios test — they are about the read-set the decision was computed
      // from, so the verdict is held constant at `pass` and the refusal, when it comes, is the fence's.
      seriesGate: async () => ({ decision: "pass" as const, reasons: [] }),
      newId: () => `${prefix}-${n++}`,
      now: () => new Date().toISOString(),
    });
    const product = await service.create({
      tenant: "trust",
      createdBy: "captain",
      name: "Copilot",
      services: [{ name: "api", repository: "acme/copilot", source: "releases" as const }],
      series: [{ ...SERIES, requiredForRelease: false }],
    });
    return { service, product, scorecards, issues, releases };
  }

  it("an issue linked between the decision and the write REFUSES the ship", async () => {
    const { service, product, issues, releases } = await world();
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.3",
    });
    // The decision reads zero open issues…
    expect((await service.releaseDetail("trust", release.id)).readiness.openIssues).toBe(0);
    // …and a concurrent replica links a blocking one after the decision and before the write.
    releases.onNextWrite(async () => {
      // Raw INSERT rather than the record mapper: this fixture only needs a ROW the fence can count, and
      // building a full IssueRecord would couple the scenario to every column the tracker later grows.
      await pg.client.query(
        `INSERT INTO everdict_issues
           (id, tenant, team_id, number, identifier, former_identifiers, title, description, status, priority,
            estimate, due_date, parent_id, cycle_id, milestone_id, state_id, in_triage, project_id, assignee,
            label_ids, links, resolution, github, history, created_by, origin, created_at, updated_at)
         VALUES ($1,'trust','team-trust',$3::int,'TRU-' || $3::text,'[]'::jsonb,'regression in checkout',NULL,'in_progress','none',
                 NULL,NULL,NULL,NULL,NULL,NULL,false,NULL,NULL,
                 '[]'::jsonb,$2::jsonb,NULL,NULL,'[]'::jsonb,'dana',NULL,now(),now())`,
        // (team_id, number) is unique, and this suite runs against a SHARED database — a fixed number
        // collides with the previous run rather than testing anything.
        [trustId("iss"), JSON.stringify([{ type: "release", id: release.id }]), Date.now() % 1_000_000],
      );
    });
    // Pre-fix this committed and recorded `openIssues: 0, force: false` — a statement the ledger could not
    // support at its own linearization point.
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await service.getRelease("trust", release.id)).status).toBe("planned");
  });

  it("a NEWER candidate landing between the decision and the write REFUSES the ship", async () => {
    const { service, product, scorecards, releases } = await world();
    await scorecards.create(
      seriesBatch(trustId("sc-old"), product.id, "2026-08-01T00:00:00.000Z", [scored("a", true)]),
    );
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.4",
    });
    // The decision compares the batch that is latest NOW…
    const before = (await service.releaseDetail("trust", release.id)).readiness.series[0];
    expect(before?.latest?.createdAt).toBe("2026-08-01T00:00:00.000Z");
    // …and a newer one lands after that decision, before the write.
    releases.onNextWrite(async () => {
      await scorecards.create(
        seriesBatch(trustId("sc-new"), product.id, "2026-08-09T00:00:00.000Z", [scored("a", false)]),
      );
    });
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a contract that moves mid-decision REFUSES — the ambient half, re-verified rather than fenced", async () => {
    // The evaluation contract is resolved from REGISTRIES and workspace settings, none of which touch a row
    // the CAS can condition on. So this half is a RE-VERIFY between the decision and the commit, and it is
    // labelled as one: it cannot close the window inside the commit itself, which would need a registry
    // generation. Saying which of the two it is beats implying the stronger one.
    const products = new PgProductStore(pg.client);
    const releases = new PgReleaseStore(pg.client);
    let contractDigest = "sha256:contract-A";
    let n = 0;
    const prefix = trustId("t121c");
    const service = new ProductService({
      store: products,
      releases,
      versions: new PgProductVersionStore(pg.client),
      issues: new PgIssueStore(pg.client),
      scorecards: new PgScorecardStore(pg.client),
      resolveSeriesContract: async () => ({
        status: "resolved" as const,
        digest: contractDigest,
        contract: { dataset: { id: "d", version: "1" }, harness: { id: "h", version: "1" }, judges: [] },
      }),
      newId: () => `${prefix}-${n++}`,
      now: () => new Date().toISOString(),
    });
    const product = await service.create({
      tenant: "trust",
      createdBy: "captain",
      name: "Copilot",
      services: [{ name: "api", repository: "acme/copilot", source: "releases" as const }],
      series: [{ ...SERIES, requiredForRelease: false }],
    });
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.6",
    });
    // The registry moves after the decision resolved its contract — a new `latest`, or a workspace-local
    // document shadowing a shared one. The product row is untouched, so nothing the CAS guards can see it.
    let reads = 0;
    const moving = service as unknown as { deps: { resolveSeriesContract: () => Promise<unknown> } };
    const original = moving.deps.resolveSeriesContract;
    moving.deps.resolveSeriesContract = async (...args: unknown[]) => {
      reads += 1;
      if (reads === 2) contractDigest = "sha256:contract-B"; // moved between the decision and the commit
      return (original as (...a: unknown[]) => Promise<unknown>)(...args);
    };
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("…and with nothing moving, the same ship commits — the fence is not a wall", async () => {
    const { service, product, scorecards } = await world();
    await scorecards.create(
      seriesBatch(trustId("sc-only"), product.id, "2026-08-02T00:00:00.000Z", [scored("a", true)]),
    );
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.5",
    });
    const shipped = await service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" });
    expect(shipped.status).toBe("released");
  });
});
