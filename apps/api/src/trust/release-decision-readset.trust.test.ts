import { ProductService } from "@everdict/application-control";
import type { CaseResult, ProductSeries, ScorecardRecord } from "@everdict/contracts";
import { MANIFEST_IDENTITY_VERSION } from "@everdict/contracts";
import {
  PgCapabilityGenerationStore,
  PgIssueStore,
  PgProductStore,
  PgProductVersionStore,
  PgReleaseStore,
  PgScorecardStore,
} from "@everdict/db";
import { PgDatasetRegistry } from "@everdict/registry";
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
      // The fence under test reads generations; without the reader the guard simply omits that condition.
      capabilityGenerations: new PgCapabilityGenerationStore(pg.client),
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

  it("a RE-SCORE of the pinned candidate refuses — the row is unchanged, the judgment is not", async () => {
    // The case a timestamp fence is structurally blind to. Re-scoring S10 leaves `created_at` exactly where
    // it was while replacing the verdict the gate read, so "nothing newer than S10" stays true of a world that
    // no longer exists. Which row was latest and which judgment of that row was read are ONE identity.
    const { service, product, scorecards, releases } = await world();
    const id = trustId("sc-rescored");
    await scorecards.create(seriesBatch(id, product.id, "2026-08-04T00:00:00.000Z", [scored("a", true)]));
    await scorecards.update(id, {
      scoring: [
        {
          revision: 1,
          kind: "initial",
          judges: [],
          scorePlaneDigest: "sha256:plane-1",
          createdAt: "2026-08-04T00:01:00.000Z",
        },
      ],
    } as never);
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.10",
    });
    releases.onNextWrite(async () => {
      // A re-score settles a NEW revision over the same row, between the decision and the write.
      await scorecards.update(id, {
        scoring: [
          {
            revision: 1,
            kind: "initial",
            judges: [],
            scorePlaneDigest: "sha256:plane-1",
            createdAt: "2026-08-04T00:01:00.000Z",
          },
          {
            revision: 2,
            kind: "rescore",
            judges: [],
            scorePlaneDigest: "sha256:plane-2",
            createdAt: "2026-08-04T00:02:00.000Z",
          },
        ],
      } as never);
    });
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a LIVE scoring pass over the candidate refuses — the plane is mid-revision at commit", async () => {
    const { service, product, scorecards, releases } = await world();
    const id = trustId("sc-claimed");
    await scorecards.create(seriesBatch(id, product.id, "2026-08-05T00:00:00.000Z", [scored("a", true)]));
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.11",
    });
    releases.onNextWrite(async () => {
      await scorecards.update(
        id,
        {
          scoringPass: {
            passId: "pass-live",
            epoch: 1,
            leaseUntil: "2999-01-01T00:00:00.000Z",
            heartbeatAt: "2026-08-05T00:01:00.000Z",
            targetRevision: 2,
            baseRevision: 1,
            judges: [],
            startedAt: "2026-08-05T00:01:00.000Z",
            status: "running",
          },
        } as never,
        undefined,
        { expectScoringPassId: null },
      );
    });
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("the pinned candidate being DELETED refuses — absence leaves nothing 'newer' to find", async () => {
    const { service, product, scorecards, releases } = await world();
    const id = trustId("sc-deleted");
    await scorecards.create(seriesBatch(id, product.id, "2026-08-06T00:00:00.000Z", [scored("a", true)]));
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.12",
    });
    releases.onNextWrite(async () => {
      await scorecards.delete(id);
    });
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a new candidate at the SAME millisecond refuses — `>` on a timestamp is not an ordering", async () => {
    // The list orders by (created_at, id); a row arriving in the same millisecond is not `>` the pin, and
    // deciding which of the two is latest is exactly what the tie-break exists for.
    const { service, product, scorecards, releases } = await world();
    const at = "2026-08-07T00:00:00.000Z";
    // Ids that sort either side of each other, unique per run (a shared database keeps every past fixture).
    const stamp = trustId("tie");
    const first = `aaa-${stamp}`;
    const second = `zzz-${stamp}`;
    await scorecards.create(seriesBatch(first, product.id, at, [scored("a", true)]));
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.13",
    });
    releases.onNextWrite(async () => {
      await scorecards.create(seriesBatch(second, product.id, at, [scored("a", false)]));
    });
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a capability REGISTERED between the decision and the write refuses — the ambient half, fenced", async () => {
    // A new version, or a workspace-local document shadowing a `_shared` one, changes what the series' refs
    // resolve to. Both are INSERTS in a table this database owns, so unlike the settings edit below they do
    // not have to wait for a re-verify: they are conditions on the write itself.
    const { service, product, scorecards, releases } = await world();
    await scorecards.create(
      seriesBatch(trustId("sc-cap"), product.id, "2026-08-03T00:00:00.000Z", [scored("a", true)]),
    );
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.9",
    });
    releases.onNextWrite(async () => {
      // The dataset the watched series names gains a version under this workspace, after the decision read it.
      const version = trustId("v");
      await pg.client.query(
        `INSERT INTO everdict_datasets (tenant, id, version, dataset, created_at)
         VALUES ('trust', 'support-cases', $1, '{"id":"support-cases","version":"9.9.9","cases":[],"tags":[]}'::jsonb, now())`,
        [version],
      );
      await pg.client.query(
        `INSERT INTO everdict_capability_generation (tenant, kind, id, generation, updated_at)
         VALUES ('trust','dataset','support-cases',1,now())
         ON CONFLICT (tenant, kind, id) DO UPDATE SET generation = everdict_capability_generation.generation + 1`,
      );
    });
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a REVIVED tombstone refuses — the shadow that leaves every timestamp where it was", async () => {
    // The case a `created_at` fence is structurally blind to (arch-review 23 P0-2). A workspace-local
    // document that was soft-deleted still HAS its original row: re-registering identical content sets
    // `deleted_at = NULL` and inserts nothing. So a local `support-cases` can come back to life over the
    // `_shared` one the decision resolved, mid-decision, with no timestamp anywhere moving.
    const { service, product, scorecards, releases } = await world();
    await scorecards.create(
      seriesBatch(trustId("sc-revive"), product.id, "2026-08-08T00:00:00.000Z", [scored("a", true)]),
    );
    // The tombstone exists BEFORE the decision — its `created_at` is in the past, which is the whole point.
    const version = trustId("dead");
    await pg.client.query(
      `INSERT INTO everdict_datasets (tenant, id, version, dataset, created_at, deleted_at)
       VALUES ('trust', 'support-cases', $1, '{"id":"support-cases","version":"1.0.0","cases":[],"tags":[]}'::jsonb,
               now() - interval '30 days', now() - interval '1 day')`,
      [version],
    );
    await pg.client.query(
      `INSERT INTO everdict_capability_generation (tenant, kind, id, generation, updated_at)
       VALUES ('trust','dataset','support-cases',7,now())
       ON CONFLICT (tenant, kind, id) DO UPDATE SET generation = 7`,
    );
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.14",
    });
    releases.onNextWrite(async () => {
      // The revive: an UPDATE, not an insert. `created_at` is untouched — only the generation moves.
      await pg.client.query(
        `UPDATE everdict_datasets SET deleted_at = NULL WHERE tenant = 'trust' AND id = 'support-cases' AND version = $1`,
        [version],
      );
      await pg.client.query(
        `UPDATE everdict_capability_generation SET generation = generation + 1
         WHERE tenant = 'trust' AND kind = 'dataset' AND id = 'support-cases'`,
      );
    });
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  // ── arch-review 24 P0-2/P0-1: the token is a VECTOR, and it advances with the mutation ──────────────
  //
  // HISTORICAL TIME DOES NOT ESTABLISH MUTATION AUTHORITY, and neither does an aggregate over two clocks. A
  // fence needs the generation of EVERY namespace that can answer the name, each compared on its own, and it
  // needs that generation to move as part of the mutation rather than shortly after it.
  describe("TRUST-130 — the capability fence is a per-namespace vector, advanced inside the mutation", () => {
    it("a TENANT-side mutation refuses even while `_shared` sits at a higher number — two clocks, compared apart", async () => {
      // Owner-first resolution means either namespace can change what `support-cases` answers, and the two
      // counters advance independently. The fence used to read `max(generation)` across both, which is a
      // PROJECTION of the pair rather than the pair: with `_shared` at 100 and the tenant at 3, a tenant
      // mutation to 4 leaves the maximum at 100 — the decision reads 100 before, 100 after, and commits
      // believing nothing moved. The failure direction is always "nothing changed", which is the one direction
      // a fence must never guess in.
      const { service, product, scorecards, releases } = await world();
      await pg.client.query(
        `INSERT INTO everdict_capability_generation (tenant, kind, id, generation, updated_at)
       VALUES ('_shared','dataset','support-cases',100,now()), ('trust','dataset','support-cases',3,now())
       ON CONFLICT (tenant, kind, id) DO UPDATE SET generation = excluded.generation`,
      );
      await scorecards.create(
        seriesBatch(trustId("sc-vec"), product.id, "2026-08-10T00:00:00.000Z", [scored("a", true)]),
      );
      const release = await service.createRelease({
        tenant: "trust",
        createdBy: "captain",
        productId: product.id,
        name: "2026.20",
      });
      releases.onNextWrite(async () => {
        await pg.client.query(
          `UPDATE everdict_capability_generation SET generation = 4
         WHERE tenant = 'trust' AND kind = 'dataset' AND id = 'support-cases'`,
        );
      });
      await expect(
        service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("the REAL registry advances the fence in the same statement as the write it fences", async () => {
      // The scenarios above move the generation by hand, which certifies the GUARD and says nothing about the
      // producer. This one calls the production registration path end to end: a mutation path that forgot to
      // advance the fence — or advanced it and swallowed the failure — commits here. That the bump now travels
      // INSIDE the mutation's own statement is certified where the SQL is
      // (`packages/registry/src/pg-versioned-store-invariants.test.ts`); what this adds is that the real
      // registry, wired as the control plane wires it, moves the number at all.
      const { service, product, scorecards, releases } = await world();
      await scorecards.create(
        seriesBatch(trustId("sc-reg"), product.id, "2026-08-10T00:00:00.000Z", [scored("a", true)]),
      );
      const release = await service.createRelease({
        tenant: "trust",
        createdBy: "captain",
        productId: product.id,
        name: "2026.21",
      });
      const registry = new PgDatasetRegistry(pg.client);
      releases.onNextWrite(async () => {
        await registry.register("trust", {
          id: "support-cases",
          version:
            trustId("v")
              .replace(/[^0-9a-z]/g, "")
              .slice(0, 8) || "9.9.9",
          cases: [],
          tags: [],
        } as never);
      });
      await expect(
        service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  // arch-review 27: WHAT A DECISION READ IS AUTOMATICALLY WHAT ITS COMMIT CONDITIONS ON. The read-set used to
  // be an anonymous shape declared inline on the guard and repeated in the store, so a new member had to be
  // remembered in four places — and a forgotten clause does not fail, it commits under a weaker guard. This
  // reads the shipped record instead of the code: the decision's own digest is written into the history
  // entry, so two ships can be told apart by what they READ without re-deriving any of it.
  it("the ship records the DIGEST of the read-set it decided under", async () => {
    const { service, product, scorecards } = await world();
    await scorecards.create(
      seriesBatch(trustId("sc-ctx"), product.id, "2026-08-12T00:00:00.000Z", [scored("a", true)]),
    );
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.40",
    });
    await service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" });
    const shipped = await service.getRelease("trust", release.id);
    const entry = shipped.history?.[shipped.history.length - 1];
    const digest = (entry?.detail as { contextDigest?: unknown } | undefined)?.contextDigest;
    expect(typeof digest).toBe("string");
    expect(digest).toMatch(/^sha256:/);
  });

  it("a workspace SETTINGS change refuses — the default judge model is contract identity, and it is a row", async () => {
    // The comment this replaces said the ambient half "cannot be a row condition". The settings ARE a row, in
    // this database, beside everything else the ship conditions on (arch-review 23 P0-3): an identical judge
    // list judged by a different model is a different judging apparatus.
    const { service, product, scorecards, releases } = await world();
    await scorecards.create(
      seriesBatch(trustId("sc-settings"), product.id, "2026-08-09T00:00:00.000Z", [scored("a", true)]),
    );
    await pg.client.query(
      `INSERT INTO everdict_workspace_settings (workspace, settings, updated_at, revision)
       VALUES ('trust', '{}'::jsonb, now(), 1)
       ON CONFLICT (workspace) DO UPDATE SET revision = everdict_workspace_settings.revision + 1`,
    );
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.15",
    });
    releases.onNextWrite(async () => {
      await pg.client.query(
        `UPDATE everdict_workspace_settings SET revision = revision + 1, updated_at = now() WHERE workspace = 'trust'`,
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
        // No nested closure to fence — this scenario is about the contract DIGEST, and the read-set is the
        // resolution's own statement rather than something a reader infers from the refs.
        documents: [],
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
