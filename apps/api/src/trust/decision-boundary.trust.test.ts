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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-136.
//
// A FENCE THAT COULD NOT BE READ IS NOT AN ABSENT FENCE.
//
// Every condition a ship commits under was read from somewhere, and every one of those reads was wrapped in
// `.catch(() => undefined)`. That turned "I could not find out whether the world moved" into "this decision
// needs no such condition" — silently, in the direction of green, at the one transition a workspace cannot
// take back. The guard SQL then simply omitted the clause, so the release committed under a strictly weaker
// rule than the deployment is configured to enforce, and nothing anywhere recorded that it had.
//
// The asymmetry is the whole argument: an operator can retry a refused ship. Nobody can un-ship a release.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-136 — a ship refuses when it cannot read its own fences", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => pg?.close());

  const SERIES: ProductSeries = {
    key: "quality",
    label: "Quality",
    dataset: { id: "support-cases" },
    harness: { id: "agent" },
    judges: [],
  };

  const scored = (caseId: string, pass: boolean): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores: [{ graderId: "g", metric: "quality", value: pass ? 1 : 0, pass, status: "measured" }],
  });

  // The record shape, taken from the scenario that already drives these stores rather than re-invented: a
  // hand-rolled fixture that fails `RunRecordSchema` leaves an unparseable row in a SHARED database and
  // breaks the next scenario's `list`, which is a trap this suite has already sprung once.
  const batch = (id: string, productId: string, createdAt: string, results: CaseResult[]): ScorecardRecord =>
    ({
      id,
      tenant: "trust",
      dataset: { id: "support-cases", version: "1.0.0" },
      harness: { id: "agent", version: "1.0.0" },
      status: "succeeded",
      scorecard: { suiteId: "support-cases@1.0.0", harness: "agent@1.0.0", results },
      summary: [
        {
          metric: "quality",
          count: results.length,
          passRate:
            results.filter((r) => r.scores[0] && "pass" in r.scores[0] && r.scores[0].pass).length / results.length,
        },
      ],
      manifest: {
        identityVersion: MANIFEST_IDENTITY_VERSION,
        dataset: { id: "support-cases", version: "1.0.0", digest: "sha256:composite" },
        cases: { a: "sha256:case-a" },
        grading: "sha256:grading",
        harness: { id: "agent", version: "1.0.0" },
      },
      origin: { source: "product", productId, seriesKey: "quality" },
      createdAt,
      updatedAt: createdAt,
    }) as ScorecardRecord;

  // The store that CANNOT ANSWER. Not absent — wired, configured, and failing, which is the state the
  // swallowed catch could not tell apart from "this deployment has no fence".
  const brokenGenerations = (which: "read" | "settings") => ({
    async read(tenant: string, refs: ReadonlyArray<{ kind: string; id: string }>) {
      if (which === "read") throw new Error("connection reset by peer");
      return new PgCapabilityGenerationStore(pg.client).read(tenant, refs);
    },
    async settingsRevision(workspace: string) {
      if (which === "settings") throw new Error("connection reset by peer");
      return new PgCapabilityGenerationStore(pg.client).settingsRevision(workspace);
    },
  });

  async function world(generations: unknown) {
    let n = 0;
    const prefix = trustId("t136");
    const service = new ProductService({
      store: new PgProductStore(pg.client),
      releases: new PgReleaseStore(pg.client),
      versions: new PgProductVersionStore(pg.client),
      issues: new PgIssueStore(pg.client),
      scorecards: new PgScorecardStore(pg.client),
      capabilityGenerations: generations as never,
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
    const scorecards = new PgScorecardStore(pg.client);
    await scorecards.create(batch(trustId("sc"), product.id, "2026-08-11T00:00:00.000Z", [scored("a", true)]));
    return { service, product };
  }

  it("a capability-generation read that FAILS refuses the ship — it does not ship unfenced", async () => {
    const { service, product } = await world(brokenGenerations("read"));
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.30",
    });
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    // …and the release is exactly where it was. A refusal is a non-event; the pre-fix behaviour was a ship.
    expect((await service.getRelease("trust", release.id)).status).toBe("planned");
  });

  it("a settings-revision read that FAILS refuses the ship for the same reason", async () => {
    const { service, product } = await world(brokenGenerations("settings"));
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.31",
    });
    await expect(
      service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect((await service.getRelease("trust", release.id)).status).toBe("planned");
  });

  it("…and a working fence still ships — the refusal is about the READ, not about being cautious", async () => {
    // The other half, and the reason the first two mean anything: if a wired fence refused every ship, "it
    // refused" would say nothing about whether it could read.
    const { service, product } = await world(new PgCapabilityGenerationStore(pg.client));
    const release = await service.createRelease({
      tenant: "trust",
      createdBy: "captain",
      productId: product.id,
      name: "2026.32",
    });
    await service.setReleaseStatus("trust", release.id, { status: "released" }, { subject: "captain" });
    expect((await service.getRelease("trust", release.id)).status).toBe("released");
  });
});
