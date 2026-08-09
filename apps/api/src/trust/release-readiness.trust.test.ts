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
import { evaluateGate, productReleasePolicyDigest } from "@everdict/domain";
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
    // The PRODUCTION seam, byte-for-byte the main.ts wiring — the point of this certification. Including
    // `diffSnapshot` over `diff`: the decision records the pins the GATE read, not a separate list read's
    // (arch-review 10 P0). A certificate that wires the seam differently from production certifies the wiring
    // it invented.
    seriesGate: async (tenant, baselineId, candidateId) => {
      const snapshot = await scorecardService.diffSnapshot(tenant, baselineId, candidateId, {});
      const evaluation = evaluateGate(snapshot.diff, { maxRegressions: 0 });
      return {
        decision: evaluation.decision,
        reasons: evaluation.reasons,
        ...(snapshot.baseline.pin !== undefined ? { baselineScoring: snapshot.baseline.pin } : {}),
        ...(snapshot.candidate.pin !== undefined ? { candidateScoring: snapshot.candidate.pin } : {}),
      };
    },
    newId: () => `t37-${n++}`,
    now: () => "2026-08-04T00:00:00.000Z",
  });
  return { scorecardStore, productService };
}

// The series a product ships against. `allowNoBaseline` is DECLARED, because the first ship of a required
// series is a bootstrap and a bootstrap is a governance decision (arch-review 8/9): a required series with no
// prior anchor blocks until someone approves shipping on absolute evidence. A fixture that omitted it was
// certifying a constitution the product no longer has.
const SERIES: ProductSeries = {
  key: "quality",
  label: "Quality",
  dataset: { id: "support-cases" },
  harness: { id: "copilot" },
  judges: [],
  allowNoBaseline: true,
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
      // The DECISION, not a verdict word (arch-review 8 P1): the recorded entry names which series gated and
      // what each one carried, so the ship stays answerable a month later. `seriesVerdicts` was the old
      // shape and the certificate kept asserting it after the production contract moved — a certificate that
      // trails the constitution certifies nothing.
      seriesDecisions: expect.arrayContaining([
        expect.objectContaining({ key: "quality", verdict: "not_evaluated", required: true }),
      ]),
    });
  });

  // arch-review 10 P0. `allowNoBaseline` approves shipping the FIRST time this series ran. It must not
  // silently cover a ship whose recorded baseline has since been DELETED: history existed and we lost it,
  // which is a reason to refuse, not to fall back to the bootstrap rule. Before the resolution split, the
  // missing baseline collapsed into "no baseline" and this shipped GREEN.
  it("a ship whose recorded baseline has been deleted REFUSES, even with the bootstrap approved", async () => {
    const { scorecardStore, productService } = build();
    const product = await productService.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      services: [{ name: "api", repository: "acme/copilot-api", source: "releases" as const }],
      series: [SERIES], // allowNoBaseline: true — approved, and it does not reach the deleted-history state
    });
    await scorecardStore.create(
      seriesBatch("t37-gone", [scored("a", true), scored("b", true)], "2026-07-01T00:00:00.000Z", {
        productId: product.id,
        seriesKey: "quality",
      }),
    );
    const first = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.2",
    });
    await productService.setReleaseStatus("acme", first.id, { status: "released" }, { subject: "release-captain" });

    // The evidence that ship stood on is deleted; a newer batch exists.
    await scorecardStore.delete("t37-gone");
    await scorecardStore.create(
      seriesBatch("t37-after", [scored("a", true), scored("b", true)], "2026-08-05T00:00:00.000Z", {
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
    const readiness = (await productService.releaseDetail("acme", next.id)).readiness;
    expect(readiness.series[0]).toMatchObject({ key: "quality", verdict: "not_comparable", regressed: true });
    expect(readiness.series[0]?.reasons?.[0]).toContain("t37-gone");
    await expect(
      productService.setReleaseStatus("acme", next.id, { status: "released" }, { subject: "release-captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  // arch-review 10 P0: the release CAS guards the RELEASE row, and the policy it decided under lives in the
  // PRODUCT row. An edit to the product between readiness and commit used to sail through, recording
  // "required: true, not_evaluated" on a release that shipped without a force.
  it("a product policy edited mid-decision refuses the ship — the release's own version cannot see it move", async () => {
    // Driven at the STORE, deliberately. The race is an interleaving between one decision's readiness read
    // and its own commit, which a single-threaded service call cannot produce (it now reads the product once
    // and would simply see the new policy). The invariant being certified is that the WRITE refuses a
    // decision whose policy moved — so the certificate exercises the write, holding the stale version a
    // concurrent replica would still be holding.
    const products = new InMemoryProductStore();
    const releases = new InMemoryReleaseStore();
    releases.attachProducts(products);
    let n = 0;
    const productService = new ProductService({
      store: products,
      releases,
      versions: new InMemoryProductVersionStore(),
      newId: () => `t37-race-${n++}`,
      now: () => "2026-08-04T00:00:00.000Z",
    });
    const product = await productService.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      series: [{ ...SERIES, requiredForRelease: false }],
    });
    const release = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.3",
    });
    // The POLICY this decision read — the identity a ship now commits against (mig 0154). The row version is
    // carried too, as the store's legacy fallback, but it is not what decides.
    const stalePolicy = productReleasePolicyDigest(product);

    // The concurrent edit lands: quality becomes required. The RELEASE row is untouched — which is exactly
    // why its own version guard passes and cannot protect this decision.
    await productService.update(
      "acme",
      product.id,
      { series: [{ ...SERIES, requiredForRelease: true }] },
      { subject: "release-captain", isAdmin: true },
    );

    const releaseRow = await releases.get("acme", release.id);
    const guarded = await releases.update("acme", release.id, { status: "released" }, undefined, {
      expectStatus: "planned",
      expectVersion: releaseRow?.version ?? 0, // the release did NOT move — this half passes
      // …and this half refuses: the policy digest moved even though nothing about the release did.
      expectProduct: { id: product.id, version: product.version ?? 0, policyDigest: stalePolicy },
    });
    expect(guarded).toBeUndefined();
    // …and the same write commits once it states the policy it actually read.
    const fresh = await products.get("acme", product.id);
    await expect(
      releases.update("acme", release.id, { status: "released" }, undefined, {
        expectStatus: "planned",
        expectVersion: releaseRow?.version ?? 0,
        expectProduct: {
          id: product.id,
          version: fresh?.version ?? 0,
          policyDigest: fresh === undefined ? "" : productReleasePolicyDigest(fresh),
        },
      }),
    ).resolves.toBeDefined();
  });

  // mig 0154: the guard has to refuse for POLICY reasons and only policy reasons. A version-keyed guard
  // conflicted a ship whenever anything about the product moved — including the 15-minute sync sweep's
  // watermark, which its own contract calls bookkeeping. A guard that refuses for reasons an operator cannot
  // connect to the decision is one that gets worked around.
  it("a NON-policy product edit does not conflict an in-flight ship", async () => {
    const products = new InMemoryProductStore();
    const releases = new InMemoryReleaseStore();
    releases.attachProducts(products);
    let n = 0;
    const productService = new ProductService({
      store: products,
      releases,
      versions: new InMemoryProductVersionStore(),
      newId: () => `t37-rename-${n++}`,
      now: () => "2026-08-04T00:00:00.000Z",
    });
    const product = await productService.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      series: [{ ...SERIES, requiredForRelease: false }],
    });
    const release = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.3",
    });
    const policyAtDecision = productReleasePolicyDigest(product);

    // A rename lands mid-decision. The row version moves; the release policy does not.
    await productService.update(
      "acme",
      product.id,
      { name: "Support Copilot (EU)" },
      { subject: "release-captain", isAdmin: true },
    );
    const moved = await products.get("acme", product.id);
    expect(moved?.version).not.toBe(product.version); // the version DID move — the old guard would refuse

    const releaseRow = await releases.get("acme", release.id);
    await expect(
      releases.update("acme", release.id, { status: "released" }, undefined, {
        expectStatus: "planned",
        expectVersion: releaseRow?.version ?? 0,
        expectProduct: { id: product.id, version: product.version ?? 0, policyDigest: policyAtDecision },
      }),
    ).resolves.toBeDefined();
  });
});
