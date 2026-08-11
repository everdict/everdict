import { ProductService, ScorecardService, type ScorecardStore } from "@everdict/application-control";
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
import { evaluateGate, productEvaluationDefinitionDigest, productReleasePolicyDigest } from "@everdict/domain";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, TRUST_SUITE_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

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
  world?: ScorecardRecord["world"],
): ScorecardRecord => ({
  ...(world ? { world } : {}),
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

// `idPrefix` matters for the shared-Postgres scenarios: the product id is what a series batch's `origin`
// points at, so two scenarios minting the same ids would read each other's rows out of the real table.
function build(store?: ScorecardStore, idPrefix = "t37") {
  const scorecardStore = store ?? new InMemoryScorecardStore();
  const versions = new InMemoryProductVersionStore();
  const scorecardService = new ScorecardService({
    dispatcher: unusedDispatcher,
    store: scorecardStore,
    datasets: new InMemoryDatasetRegistry(),
  });
  let n = 0;
  const productService = new ProductService({
    store: new InMemoryProductStore(),
    releases: new InMemoryReleaseStore(),
    versions,
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
    newId: () => `${idPrefix}-${n++}`,
    now: () => "2026-08-04T00:00:00.000Z",
  });
  return { scorecardStore, productService, versions };
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
      expectProduct: {
        id: product.id,
        version: product.version ?? 0,
        policyDigest: stalePolicy,
        definitionDigest: productEvaluationDefinitionDigest(product),
      },
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
          definitionDigest: fresh === undefined ? "" : productEvaluationDefinitionDigest(fresh),
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
    const definitionAtDecision = productEvaluationDefinitionDigest(product);

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
        expectProduct: {
          id: product.id,
          version: product.version ?? 0,
          policyDigest: policyAtDecision,
          definitionDigest: definitionAtDecision,
        },
      }),
    ).resolves.toBeDefined();
  });
});

// Trust suite — TRUST-62.
//
// A SHIP LOSES TO AN EDIT OF WHAT ITS SERIES ASK. The release CAS guarded the product's governance policy —
// which series gate, which pre-approve a bootstrap — and that digest was narrowed on purpose so a rename
// stops conflicting an in-flight ship. The narrowing left the OTHER half unguarded: a decision resolves each
// series' evaluation contract (dataset × harness × judges) and nothing stopped a member replacing that
// definition mid-decision. Widening the policy digest would have undone the narrowing; two questions get two
// digests, and the write holds both.
// Trust suite — TRUST-115.
//
// HISTORY IS NOT IMMUTABLE IF DELETING THE ANCHOR CHANGES WHAT THE NEXT DECISION BELIEVES WAS "LAST TIME".
//
// `setStatus` refuses to reopen a released release, which reads as "released is history" — but that guarded
// one FIELD. The next release's gate resolves its baseline by re-reading the released rows that still exist,
// so deleting the previous ship did not fail the comparison: it made the comparison believe there had never
// been one, and a series declaring `allowNoBaseline` shipped green on a bootstrap the delete manufactured.
// The neighbouring case was already right — a released release whose candidate SCORECARD was deleted resolves
// to `missing_historical_evidence` and refuses — so the protection existed and the anchor under it did not.
// Trust suite — TRUST-118.
//
// WHAT SHIPPED IS A LEDGER ROW, NOT A STRING SOMEBODY TYPED.
//
// `{service, version}` stopped being sufficient historical identity when the version ledger became
// stream-aware: repointing a service from repo-A to repo-B means the same name tracks a different stream, and
// both can publish `v1.0.0`. A release that froze only the pair could not answer "which v1.0.0 did 2026.3
// ship?" — which is the question a release exists to answer later. The picker in the UI already refused to
// invent versions; the API accepted any non-empty string, and the ship froze it verbatim.
describeTrust("TRUST-118 — the shipped composition resolves to the ledger row it names", () => {
  async function shipWith(
    component: { service: string; version?: string; versionRecordId?: string },
    seedLedger: boolean,
  ) {
    const { productService, versions } = build();
    const product = await productService.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      services: [{ name: "api", repository: "acme/copilot-api", source: "releases" as const }],
      series: [{ ...SERIES, requiredForRelease: false }],
    });
    if (seedLedger)
      await versions.create({
        id: "ver-row-1",
        tenant: "acme",
        productId: product.id,
        service: "api",
        streamKey: "github|acme/copilot-api|releases|",
        version: "v1.0.0",
        kind: "release",
        prerelease: false,
        publishedAt: "2026-07-01T00:00:00.000Z",
        importedAt: "2026-07-01T00:01:00.000Z",
      });
    const release = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.3",
      components: [component],
    });
    await productService.setReleaseStatus("acme", release.id, { status: "released" }, { subject: "release-captain" });
    const shipped = await productService.getRelease("acme", release.id);
    const entry = shipped.history.find((h) => h.event === "released");
    return (entry?.detail as { components?: Array<Record<string, unknown>> } | undefined)?.components?.[0];
  }

  it("an UNPINNED plan matching one row freezes that row's identity — as INFERRED, not as chosen", async () => {
    // "The ledger holds exactly one row with this version" is a weaker statement than "the author meant this
    // row", and the record says which one it is (arch-review 23 P1). A pinned plan earns `ledger`.
    expect(await shipWith({ service: "api", version: "v1.0.0" }, true)).toMatchObject({
      service: "api",
      version: "v1.0.0",
      versionRecordId: "ver-row-1",
      streamKey: "github|acme/copilot-api|releases|",
      resolution: "inferred",
    });
  });

  it("a plan whose two identities DISAGREE is conflicting — one fact may not carry two authorities", async () => {
    // The picker sends the row it offered; nothing stopped an API caller from sending `version: v2` beside
    // the row for v1, and the ship froze both — a historical claim contradicting itself.
    const conflicting = await shipWith({ service: "api", version: "v2.0.0", versionRecordId: "ver-row-1" }, true);
    expect(conflicting).toMatchObject({ service: "api", version: "v2.0.0", resolution: "conflicting" });
    expect(conflicting?.versionRecordId).toBeUndefined();
    expect(conflicting?.streamKey).toBeUndefined();
  });

  it("TWO rows matching the plan is AMBIGUOUS — a resolver may not pick one and call it history", async () => {
    // The ledger is stream-aware on purpose: a service repointed from repo-A to repo-B tracks a different
    // stream under the same name, and both can publish `v1.0.0`. The store returns newest-first, so taking
    // the first match would write "this is the exact row that shipped" on the strength of a sort order.
    const { productService, versions } = build();
    const product = await productService.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      services: [{ name: "api", repository: "acme/copilot-api", source: "releases" as const }],
      series: [{ ...SERIES, requiredForRelease: false }],
    });
    for (const [id, stream] of [
      ["row-a", "github|acme/copilot-api|releases|"],
      ["row-b", "github|acme/copilot-api-v2|releases|"],
    ] as const)
      await versions.create({
        id,
        tenant: "acme",
        productId: product.id,
        service: "api",
        streamKey: stream,
        version: "v1.0.0",
        kind: "release",
        prerelease: false,
        publishedAt: "2026-07-01T00:00:00.000Z",
        importedAt: "2026-07-01T00:01:00.000Z",
      });
    const release = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.7",
      components: [{ service: "api", version: "v1.0.0" }],
    });
    await productService.setReleaseStatus("acme", release.id, { status: "released" }, { subject: "release-captain" });
    const shipped = await productService.getRelease("acme", release.id);
    const entry = shipped.history.find((h) => h.event === "released");
    const component = (entry?.detail as { components?: Array<Record<string, unknown>> } | undefined)?.components?.[0];
    // …and `ambiguous` is its own answer: "we found two" and "we found none" are different facts, and only
    // one of them is fixed by importing more versions.
    expect(component).toMatchObject({ service: "api", version: "v1.0.0", resolution: "ambiguous" });
    expect(component?.versionRecordId).toBeUndefined();
  });

  it("…and a plan that PINS the row resolves it exactly, however many share the version", async () => {
    const { productService, versions } = build();
    const product = await productService.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      services: [{ name: "api", repository: "acme/copilot-api", source: "releases" as const }],
      series: [{ ...SERIES, requiredForRelease: false }],
    });
    for (const [id, stream] of [
      ["pinned-a", "github|acme/copilot-api|releases|"],
      ["pinned-b", "github|acme/copilot-api-v2|releases|"],
    ] as const)
      await versions.create({
        id,
        tenant: "acme",
        productId: product.id,
        service: "api",
        streamKey: stream,
        version: "v1.0.0",
        kind: "release",
        prerelease: false,
        publishedAt: "2026-07-01T00:00:00.000Z",
        importedAt: "2026-07-01T00:01:00.000Z",
      });
    const release = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.8",
      components: [{ service: "api", version: "v1.0.0", versionRecordId: "pinned-b" }],
    });
    await productService.setReleaseStatus("acme", release.id, { status: "released" }, { subject: "release-captain" });
    const shipped = await productService.getRelease("acme", release.id);
    const entry = shipped.history.find((h) => h.event === "released");
    expect(
      (entry?.detail as { components?: Array<Record<string, unknown>> } | undefined)?.components?.[0],
    ).toMatchObject({
      versionRecordId: "pinned-b",
      streamKey: "github|acme/copilot-api-v2|releases|",
      resolution: "ledger",
    });
  });

  it("a version no ledger row backs still ships — and says it was never resolved", async () => {
    // Refusing here would turn a bookkeeping gap into a blocked release. Recording WHICH of the three cases
    // it was is what keeps the history honest instead of quietly equating them.
    expect(await shipWith({ service: "api", version: "v9.9.9" }, true)).toMatchObject({
      service: "api",
      version: "v9.9.9",
      resolution: "unresolved",
    });
  });

  it("a component whose version was never decided is UNPLANNED, not an empty version", async () => {
    expect(await shipWith({ service: "api" }, false)).toMatchObject({ service: "api", resolution: "unplanned" });
  });
});

describeTrust("TRUST-115 — a released release cannot be deleted or edited out from under the next decision", () => {
  async function shipped() {
    const { scorecardStore, productService } = build();
    const product = await productService.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      services: [{ name: "api", repository: "acme/copilot-api", source: "releases" as const }],
      series: [SERIES],
    });
    const first = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.2",
    });
    await scorecardStore.create(
      seriesBatch("t115-baseline", [scored("a", true), scored("b", true)], "2026-07-01T00:00:00.000Z", {
        productId: product.id,
        seriesKey: "quality",
      }),
    );
    await productService.setReleaseStatus("acme", first.id, { status: "released" }, { subject: "release-captain" });
    return { product, first, scorecardStore, productService };
  }

  it("the delete is REFUSED — even for the creator, who may delete a planned one", async () => {
    const { first, productService } = await shipped();
    await expect(
      productService.removeRelease("acme", first.id, { subject: "release-captain", isAdmin: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // …and the anchor is still there for the next decision to stand on.
    expect((await productService.getRelease("acme", first.id)).status).toBe("released");
  });

  it("…so the NEXT release still knows what last time was, instead of reading as a first ship", async () => {
    const { product, first, scorecardStore, productService } = await shipped();
    await productService
      .removeRelease("acme", first.id, { subject: "release-captain", isAdmin: true })
      .catch(() => undefined); // the refusal above; the point is what survives it
    // A candidate that REGRESSES against the ship we are not allowed to forget.
    await scorecardStore.create(
      seriesBatch("t115-latest", [scored("a", true), scored("b", false)], "2026-08-05T00:00:00.000Z", {
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
    // Pre-fix, with the anchor deleted, this read `no_baseline` under `allowNoBaseline` and SHIPPED.
    expect(readiness.series[0]).toMatchObject({ key: "quality", verdict: "block" });
  });

  it("a released release's CONTENT is frozen too — the card cannot disagree with the ship history", async () => {
    const { first, productService } = await shipped();
    await expect(
      productService.updateRelease(
        "acme",
        first.id,
        { name: "2026.2 (actually 2026.4)" },
        { subject: "release-captain", isAdmin: true },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a PLANNED release stays deletable — the guard is about history, not about releases", async () => {
    const { productService } = build();
    const product = await productService.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      services: [{ name: "api", repository: "acme/copilot-api", source: "releases" as const }],
      series: [SERIES],
    });
    const planned = await productService.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.9",
    });
    await productService.removeRelease("acme", planned.id, { subject: "release-captain", isAdmin: false });
    await expect(productService.getRelease("acme", planned.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describeTrust("TRUST-62 — editing a series' definition mid-decision refuses the ship", () => {
  it("a dataset swap invalidates an in-flight decision; a rename still does not", async () => {
    const products = new InMemoryProductStore();
    const releases = new InMemoryReleaseStore();
    releases.attachProducts(products);
    let n = 0;
    const service = new ProductService({
      store: products,
      releases,
      versions: new InMemoryProductVersionStore(),
      newId: () => `t62-${n++}`,
      now: () => "2026-08-04T00:00:00.000Z",
    });
    const product = await service.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      series: [{ ...SERIES, dataset: { id: "support-cases", version: "1.0.0" } }],
    });
    const release = await service.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.3",
    });
    const guardAt = (p: typeof product) => ({
      id: p.id,
      version: p.version ?? 0,
      policyDigest: productReleasePolicyDigest(p),
      definitionDigest: productEvaluationDefinitionDigest(p),
    });
    const atDecision = guardAt(product);

    // A RENAME must NOT conflict — that is the whole reason the policy digest was narrowed.
    await service.update("acme", product.id, { name: "Support Copilot (EU)" }, { subject: "cap", isAdmin: true });
    const row = await releases.get("acme", release.id);
    await expect(
      releases.update("acme", release.id, { status: "released" }, undefined, {
        expectStatus: "planned",
        expectVersion: row?.version ?? 0,
        expectProduct: atDecision,
      }),
    ).resolves.toBeDefined();

    // …and a DATASET SWAP must. The governance policy is byte-identical across this edit.
    const replanned = await service.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.4",
    });
    const before = await service.get("acme", product.id);
    const beforeGuard = guardAt(before);
    await service.update(
      "acme",
      product.id,
      { series: [{ ...SERIES, dataset: { id: "support-cases", version: "2.0.0" } }] },
      { subject: "cap", isAdmin: true },
    );
    const after = await service.get("acme", product.id);
    expect(productReleasePolicyDigest(after)).toBe(productReleasePolicyDigest(before)); // governance unchanged
    expect(productEvaluationDefinitionDigest(after)).not.toBe(productEvaluationDefinitionDigest(before));
    const row2 = await releases.get("acme", replanned.id);
    await expect(
      releases.update("acme", replanned.id, { status: "released" }, undefined, {
        expectStatus: "planned",
        expectVersion: row2?.version ?? 0,
        expectProduct: beforeGuard,
      }),
    ).resolves.toBeUndefined();
  });
});

// Trust suite — TRUST-69.
//
// A DIMENSION WITH NO DIGEST YET IS GUARDED BY THE ROW VERSION, NOT WAVED THROUGH.
//
// Mig 0154 gave the release CAS a governance digest and mig 0160 gave it an evaluation-definition digest;
// each is self-healing, falling back to the product's row version until its own column is populated. The
// first implementation shared ONE fallback across both dimensions, and that is fail-open on exactly the
// combination a rolling deploy produces: `release_policy_digest` populated, `evaluation_definition_digest`
// still NULL because nothing running the new code has written that product yet. The definition clause passed
// on NULL, and the shared fallback was skipped BECAUSE the policy digest was present — so an old replica
// could edit a series' definition, bump the version, and a decision resolved before that edit would still
// commit.
//
// Certified against real Postgres because the guard is a correlated EXISTS inside the UPDATE; the two twins
// are asserted to agree, since an in-memory pair that drifts here would hide the whole class.
// Trust suite — TRUST-106.
//
// THE WORLD CROSSES THE DATABASE, OR IT DOES NOT EXIST. The cohort a batch ran in is derived at settle and
// consumed by the release decision, and everything between those two points is Postgres. A domain-level
// certificate proves `crossWorldReason` means the right thing; it cannot prove the release path ever sees a
// world, and the first cut of this feature had no column at all — every comparison would have read as
// within-world, which is the reassuring answer rather than the true one. Product readiness reads scorecards
// through `list`, so this drives the PRODUCTION seam end to end: PgScorecardStore → ProductService →
// ReleaseSeriesState.
describe.skipIf(!TRUST_PG_ENABLED)(
  "TRUST-106 — a cross-world comparison is visible in the release decision (real Postgres)",
  () => {
    let pg: TrustPg;
    beforeAll(async () => {
      pg = await openTrustPg();
    });
    afterAll(async () => pg?.close());

    async function shipOverWorlds(baselineWorld: ScorecardRecord["world"], candidateWorld: ScorecardRecord["world"]) {
      const { PgScorecardStore } = await import("@everdict/db");
      const store = new PgScorecardStore(pg.client);
      const { scorecardStore, productService } = build(store, trustId("t106"));
      const product = await productService.create({
        tenant: "acme",
        createdBy: "release-captain",
        name: "Support Copilot",
        services: [{ name: "api", repository: "acme/copilot-api", source: "releases" as const }],
        series: [SERIES],
      });
      const first = await productService.createRelease({
        tenant: "acme",
        createdBy: "release-captain",
        productId: product.id,
        name: "2026.2",
      });
      await scorecardStore.create(
        seriesBatch(
          trustId("t106-base"),
          [scored("a", true), scored("b", true)],
          "2026-07-01T00:00:00.000Z",
          { productId: product.id, seriesKey: "quality" },
          baselineWorld,
        ),
      );
      await productService.setReleaseStatus("acme", first.id, { status: "released" }, { subject: "release-captain" });
      await scorecardStore.create(
        seriesBatch(
          trustId("t106-cand"),
          [scored("a", true), scored("b", true)],
          "2026-08-05T00:00:00.000Z",
          { productId: product.id, seriesKey: "quality" },
          candidateWorld,
        ),
      );
      const next = await productService.createRelease({
        tenant: "acme",
        createdBy: "release-captain",
        productId: product.id,
        name: "2026.3",
      });
      await productService.setReleaseStatus("acme", next.id, { status: "released" }, { subject: "release-captain" });
      return (await productService.releaseDetail("acme", next.id)).readiness.series[0];
    }

    it("a baseline measured on linux and a candidate on windows ship, and say so", async () => {
      const entry = await shipOverWorlds(
        { os: "linux", drivers: ["docker"], mixed: false, observed: 2 },
        { os: "windows", drivers: ["docker"], mixed: false, observed: 2 },
      );
      // It SHIPS — attaching, never blocking, is the whole design: refusing would make an infrastructure move
      // un-shippable until every baseline is re-run.
      expect(entry).toMatchObject({ key: "quality", verdict: "pass", regressed: false });
      expect(entry?.crossWorld).toBeDefined();
      // …and it rides the reasons too, so a reader seeing the verdict sees the caveat without knowing to look.
      expect(entry?.reasons?.some((r) => r.includes("linux") && r.includes("windows"))).toBe(true);
    });

    it("the same world on both sides attaches nothing — the signal stays rare enough to mean something", async () => {
      const world = { os: "linux" as const, drivers: ["docker"], mixed: false, observed: 2 };
      const entry = await shipOverWorlds(world, world);
      expect(entry?.crossWorld).toBeUndefined();
    });
  },
);

describe.skipIf(!TRUST_PG_ENABLED)("TRUST-69 — each CAS dimension falls back on its own (real Postgres)", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => pg?.close());

  it("a legacy row with only the POLICY digest populated still conflicts when the product moves", async () => {
    const { PgReleaseStore } = await import("@everdict/db");
    const releases = new PgReleaseStore(pg.client);
    const productId = trustId("prod-69");
    const releaseId = trustId("rel-69");
    // The rolling-deploy state: policy digest present (0154 populated it), definition digest still NULL, and
    // the product at version 1.
    await pg.client.query(
      `INSERT INTO everdict_products (id, tenant, name, services, series, auto_eval, history, created_by, created_at, updated_at, version, release_policy_digest)
       VALUES ($1,'trust','Shipped','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'[]'::jsonb,'dana',now(),now(),1,'policy-A')`,
      [productId],
    );
    await pg.client.query(
      `INSERT INTO everdict_product_releases (id, tenant, product_id, name, status, history, created_by, created_at, updated_at, version)
       VALUES ($1,'trust',$2,'2026.4','planned','[]'::jsonb,'dana',now(),now(),0)`,
      [releaseId, productId],
    );

    // An old replica edits the series definition and bumps the product's version. It cannot populate the new
    // column — it has never heard of it.
    await pg.client.query("UPDATE everdict_products SET version = 2 WHERE id = $1", [productId]);

    // A decision resolved BEFORE that edit now tries to commit. It read version 1 and definition digest
    // "def-A" (what it resolved), and the policy digest still matches.
    const refused = await releases.update("trust", releaseId, { status: "released" }, undefined, {
      expectProduct: { id: productId, version: 1, policyDigest: "policy-A", definitionDigest: "def-A" },
    });
    expect(refused).toBeUndefined(); // pre-fix: committed, because the NULL definition column passed

    // …and the same decision re-resolved against the CURRENT version commits, so the guard is not a wall.
    const committed = await releases.update("trust", releaseId, { status: "released" }, undefined, {
      expectProduct: { id: productId, version: 2, policyDigest: "policy-A", definitionDigest: "def-A" },
    });
    expect(committed?.status).toBe("released");

    await pg.client.query("DELETE FROM everdict_product_releases WHERE id=$1", [releaseId]);
    await pg.client.query("DELETE FROM everdict_products WHERE id=$1", [productId]);
  });

  it("the in-memory twin answers identically — the fallback must not differ by store", async () => {
    const { InMemoryProductStore, InMemoryReleaseStore } = await import("@everdict/db");
    const products = new InMemoryProductStore();
    const releases = new InMemoryReleaseStore();
    releases.attachProducts(products);
    await products.create({
      id: "p1",
      tenant: "trust",
      name: "Shipped",
      services: [],
      series: [],
      autoEval: { enabled: false },
      createdBy: "dana",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      version: 1,
      releasePolicyDigest: "policy-A",
      // evaluationDefinitionDigest deliberately absent — the legacy half
    } as never);
    await releases.create({
      id: "r1",
      tenant: "trust",
      productId: "p1",
      name: "2026.4",
      status: "planned",
      createdBy: "dana",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      version: 0,
    } as never);
    await products.update("trust", "p1", { version: 2 } as never);
    expect(
      await releases.update("trust", "r1", { status: "released" }, undefined, {
        expectProduct: { id: "p1", version: 1, policyDigest: "policy-A", definitionDigest: "def-A" },
      }),
    ).toBeUndefined();
  });
});
