import { ProductService, ScorecardService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { CaseResult, ProductSeries, ScorecardRecord } from "@everdict/contracts";
import { MANIFEST_IDENTITY_VERSION } from "@everdict/contracts";
import {
  InMemoryIssueStore,
  InMemoryProductStore,
  InMemoryProductVersionStore,
  InMemoryReleaseStore,
  InMemoryScorecardStore,
} from "@everdict/db";
import { evaluateGate } from "@everdict/domain";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-37.
//
// THE RELEASE PATH SPEAKS THE SCORECARD GATE'S VERDICT, AND NOT EVALUATED IS NEVER GREEN. Product release
// readiness is the weakest path to a shipped claim, and it used to run its own arithmetic: "no evaluation →
// no regression → ready" shipped a product whose watched series never ran, and a bare pass-rate compare
// bypassed experiment identity, policy identity, coverage, criticals and trials. The seam is now the
// PRODUCTION wiring certified here end to end: seriesGate = scorecardService.diff + evaluateGate
// ({maxRegressions: 0}) — the exact closure main.ts binds — so a series' release verdict IS the trust
// kernel's decision, a never-evaluated required series BLOCKS, and the opt-out (requiredForRelease: false)
// is a recorded declaration, never a silent default. A faked gate seam cannot prove this: the routes suite
// fakes it at the transport level and says so — this file is the integration those tests defer to.
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("the release gate never dispatches");
  },
};

// A REAL diffable series batch: results + an era-declared manifest, so the production gate can verify
// identity and judge case transitions — a summary-only fixture would read not_comparable, not block.
const scored = (caseId: string, pass: boolean): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
  scores: [{ graderId: "t", metric: "tests_pass", value: pass ? 1 : 0, pass }],
});
const seriesBatch = (
  id: string,
  results: CaseResult[],
  createdAt: string,
  origin: Record<string, string>,
): ScorecardRecord => ({
  id,
  tenant: "acme",
  dataset: { id: "support-cases", version: "1.0.0" },
  harness: { id: "copilot", version: "1.0.0" },
  status: "succeeded",
  scorecard: { suiteId: "support-cases@1.0.0", harness: "copilot@1.0.0", results },
  summary: [
    {
      metric: "tests_pass",
      count: results.length,
      passRate: results.filter((r) => r.scores[0] && "pass" in r.scores[0] && r.scores[0].pass).length / results.length,
    },
  ],
  manifest: {
    identityVersion: MANIFEST_IDENTITY_VERSION,
    dataset: { id: "support-cases", version: "1.0.0", digest: "sha256:composite" },
    cases: { a: "sha256:case-a", b: "sha256:case-b" },
    grading: "sha256:grading",
    harness: { id: "copilot", version: "1.0.0" },
  },
  origin: { source: "product", ...origin },
  createdAt,
  updatedAt: createdAt,
});

function build() {
  const scorecardStore = new InMemoryScorecardStore();
  const scorecardService = new ScorecardService({
    dispatcher: unusedDispatcher,
    store: scorecardStore,
    datasets: new InMemoryDatasetRegistry(),
  });
  let n = 0;
  const productService = new ProductService({
    store: new InMemoryProductStore(),
    releases: new InMemoryReleaseStore(),
    versions: new InMemoryProductVersionStore(),
    issues: new InMemoryIssueStore(),
    scorecards: scorecardStore,
    // The PRODUCTION seam, byte-for-byte the main.ts wiring — the point of this certification.
    seriesGate: async (tenant, baselineId, candidateId) => {
      const diff = await scorecardService.diff(tenant, baselineId, candidateId, {});
      const evaluation = evaluateGate(diff, { maxRegressions: 0 });
      return { decision: evaluation.decision, reasons: evaluation.reasons };
    },
    newId: () => `t37-${n++}`,
    now: () => "2026-08-04T00:00:00.000Z",
  });
  return { scorecardStore, productService };
}

const SERIES: ProductSeries = {
  key: "quality",
  label: "Quality",
  dataset: { id: "support-cases" },
  harness: { id: "copilot" },
  judges: [],
};

describeTrust("TRUST-37 — the release gate is the scorecard gate, certified through the production seam", () => {
  it("a case-verdict regression in the watched series blocks the ship with the kernel's own verdict", async () => {
    const { scorecardStore, productService } = build();
    const product = await productService.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      services: [{ name: "api", repository: "acme/copilot-api", source: "releases" as const }],
      series: [SERIES],
    });
    // First release ships cleanly over the baseline batch (both cases pass).
    const first = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.2",
    });
    await scorecardStore.create(
      seriesBatch("t37-baseline", [scored("a", true), scored("b", true)], "2026-07-01T00:00:00.000Z", {
        productId: product.id,
        seriesKey: "quality",
      }),
    );
    await productService.setReleaseStatus("acme", first.id, { status: "released" }, { subject: "release-captain" });

    // A later batch breaks case "b" — the REAL diff sees the case-verdict transition, the REAL gate blocks.
    await scorecardStore.create(
      seriesBatch("t37-latest", [scored("a", true), scored("b", false)], "2026-08-05T00:00:00.000Z", {
        productId: product.id,
        seriesKey: "quality",
      }),
    );
    const next = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.3",
    });
    await expect(
      productService.setReleaseStatus("acme", next.id, { status: "released" }, { subject: "release-captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const readiness = (await productService.releaseDetail("acme", next.id)).readiness;
    expect(readiness.series[0]).toMatchObject({ key: "quality", verdict: "block" });
    // The refusal carries the kernel's OWN reason vocabulary — the case-verdict transition, not arithmetic.
    expect(readiness.series[0]?.reasons?.some((r) => r.includes("case verdict flipped"))).toBe(true);
  });

  it("a required series that never ran BLOCKS; the declared opt-out ships and both verdicts are recorded", async () => {
    const { productService } = build();
    const product = await productService.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      services: [{ name: "api", repository: "acme/copilot-api", source: "releases" as const }],
      // One required-by-default series that never runs, one DECLARED opt-out.
      series: [SERIES, { ...SERIES, key: "latency", label: "Latency", requiredForRelease: false }],
    });
    const release = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.3",
    });
    await expect(
      productService.setReleaseStatus("acme", release.id, { status: "released" }, { subject: "release-captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const readiness = (await productService.releaseDetail("acme", release.id)).readiness;
    expect(readiness.ready).toBe(false);
    expect(readiness.series.find((s) => s.key === "quality")).toMatchObject({
      verdict: "not_evaluated",
      regressed: true, // blocks
    });
    // The opt-out series carries the SAME honest verdict — it just doesn't block (a declaration, not silence).
    expect(readiness.series.find((s) => s.key === "latency")).toMatchObject({
      verdict: "not_evaluated",
      regressed: false,
    });
    // Forcing the ship records the verdict snapshot the gate saw — an override is never a clean release.
    const forced = await productService.setReleaseStatus(
      "acme",
      release.id,
      { status: "released", force: true },
      { subject: "release-captain" },
    );
    expect(forced.history.at(-1)?.detail).toMatchObject({
      forced: true,
      seriesVerdicts: expect.arrayContaining([{ key: "quality", verdict: "not_evaluated" }]),
    });
  });
});
