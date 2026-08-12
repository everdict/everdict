import {
  ProductDiscovery,
  ProductService,
  ProductVersionSync,
  RunService,
  SeriesEvaluator,
  type SeriesRunSubmitter,
} from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { IssueRecord, ScorecardRecord } from "@everdict/contracts";
import {
  InMemoryIssueStore,
  InMemoryProductStore,
  InMemoryProductVersionStore,
  InMemoryReleaseStore,
  InMemoryRunStore,
  InMemoryScorecardStore,
} from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in product tests");
  },
};

const H = { "x-everdict-tenant": "acme" };
const NOW = "2026-08-08T00:00:00.000Z";

function build() {
  const productStore = new InMemoryProductStore();
  const releaseStore = new InMemoryReleaseStore();
  const versionStore = new InMemoryProductVersionStore();
  const issueStore = new InMemoryIssueStore();
  const scorecardStore = new InMemoryScorecardStore();
  // The submit seam, recorded rather than executed: what these tests care about is WHICH series were fanned
  // out and how each batch was stamped, which is exactly what crosses this boundary.
  const submittedRuns: Array<Parameters<SeriesRunSubmitter>[0]> = [];
  const seriesEvaluator = new SeriesEvaluator({
    releases: releaseStore,
    submitSeriesRun: async (input) => {
      submittedRuns.push(input);
      return { id: `sc-auto-${submittedRuns.length}` };
    },
  });
  const productService = new ProductService({
    seriesEvaluator,
    store: productStore,
    releases: releaseStore,
    versions: versionStore,
    issues: issueStore,
    scorecards: scorecardStore,
    // The gate seam, faked at the transport level (the real wiring is analytics.diff + evaluateGate — see
    // main.ts; TRUST-37 certifies that integration): the decision derives from the two records' summaries,
    // which is enough to drive the route/verdict plumbing under test.
    seriesGate: async (_tenant, baselineId, candidateId) => {
      const baseline = await scorecardStore.get(baselineId);
      const candidate = await scorecardStore.get(candidateId);
      const rate = (r: typeof baseline) => r?.summary?.find((m) => m.passRate !== undefined)?.passRate;
      const b = rate(baseline);
      const c = rate(candidate);
      if (b === undefined || c === undefined)
        return { decision: "not_comparable" as const, reasons: [{ kind: "unmeasured_evidence", detail: "no rate" }] };
      return c < b
        ? { decision: "block" as const, reasons: [{ kind: "regression", detail: `pass rate fell ${b} → ${c}` }] }
        : { decision: "pass" as const, reasons: [] };
    },
    // A fixed clock: the regression test backdates its batches around this instant, and a real clock would
    // make the baseline anchor race the records' own timestamps.
    now: () => "2026-08-04T00:00:00.000Z",
  });
  const productVersionSync = new ProductVersionSync({
    products: productStore,
    releases: releaseStore,
    versions: versionStore,
    tokens: {
      async tokenForRepository() {
        return { token: "ghs_test" };
      },
    },
    readers: {
      for: () => ({
        async listReleases() {
          return {
            complete: true,
            rows: [
              {
                tagName: "v1.0.0",
                url: "https://github.com/acme/api/releases/v1.0.0",
                draft: false,
                prerelease: false,
                publishedAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          };
        },
        async listTags() {
          return { rows: [], complete: true };
        },
        async commitDate() {
          return undefined;
        },
      }),
    },
  });
  // The wizard's evidence read, over a repository that tags a monorepo per component. The tree half and the
  // version half are separate fakes because they are separate ports — a deployment can have one without the
  // other, and the route must degrade rather than fail.
  const productDiscovery = new ProductDiscovery({
    tokens: {
      async tokenForRepository() {
        return { token: "ghs_test" };
      },
    },
    readers: {
      for: () => ({
        async listReleases() {
          return {
            complete: true,
            rows: [
              {
                tagName: "api-v1.2.0",
                url: "https://github.com/acme/platform/releases/api-v1.2.0",
                draft: false,
                prerelease: false,
                publishedAt: "2026-08-01T00:00:00.000Z",
              },
              {
                tagName: "web-v3.1.0",
                url: "https://github.com/acme/platform/releases/web-v3.1.0",
                draft: false,
                prerelease: false,
                publishedAt: "2026-07-01T00:00:00.000Z",
              },
              // A draft has not made the "released" claim — the preview must count what an import would bring.
              { tagName: "api-v1.3.0", url: "https://x", draft: true, prerelease: false },
            ],
          };
        },
        async listTags() {
          return { rows: [], complete: true };
        },
        async commitDate() {
          return undefined;
        },
      }),
    },
    trees: {
      for: () => ({
        async listTree() {
          return {
            paths: ["package.json", "apps/api/package.json", "apps/web/package.json", "docs/readme.md"],
            truncated: false,
          };
        },
      }),
    },
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    productService,
    productVersionSync,
    productDiscovery,
  });
  return { app, issueStore, scorecardStore, submittedRuns };
}

async function createProduct(app: ReturnType<typeof build>["app"], payload?: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/products",
    headers: H,
    payload: {
      name: "Support Copilot",
      services: [{ name: "api", repository: "acme/copilot-api", source: "releases" }],
      series: [
        {
          key: "quality",
          label: "Quality",
          dataset: { id: "support-cases" },
          harness: { id: "copilot" },
          judges: [],
        },
      ],
      ...payload,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const openIssue = (releaseId: string): IssueRecord => ({
  id: "iss-1",
  tenant: "acme",
  teamId: "team-eng",
  number: 1,
  identifier: "ENG-1",
  formerIdentifiers: [],
  title: "Latency regression on long threads",
  status: "todo",
  priority: "none",
  inTriage: false,
  labelIds: [],
  links: [{ type: "release", id: releaseId, addedBy: "dana", addedAt: NOW }],
  history: [],
  createdBy: "dana",
  createdAt: NOW,
  updatedAt: NOW,
});

const seriesBatch = (
  id: string,
  passRate: number,
  createdAt: string,
  origin: Record<string, string>,
): ScorecardRecord => ({
  id,
  tenant: "acme",
  dataset: { id: "support-cases", version: "1.0.0" },
  harness: { id: "copilot", version: "1.0.0" },
  status: "succeeded",
  summary: [{ metric: "tests_pass", count: 10, passRate }],
  origin: { source: "product", ...origin },
  createdAt,
  updatedAt: createdAt,
});

describe("product routes", () => {
  it("registers a product and serves its detail with releases and versions", async () => {
    const { app } = build();
    const product = await createProduct(app);
    expect(product.autoEval).toEqual({ enabled: true });

    const detail = await app.inject({ method: "GET", url: `/products/${product.id}`, headers: H });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ name: "Support Copilot", releases: [], versions: [] });
  });

  it("hides another workspace's product — 404, never 403", async () => {
    const { app } = build();
    const product = await createProduct(app);
    const res = await app.inject({
      method: "GET",
      url: `/products/${product.id}`,
      headers: { "x-everdict-tenant": "globex" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses to ship over an open linked issue, and records the override when forced", async () => {
    const { app, issueStore } = build();
    const product = await createProduct(app);
    const planned = await app.inject({
      method: "POST",
      url: `/products/${product.id}/releases`,
      headers: H,
      payload: { name: "2026.3", targetDate: "2026-08-31" },
    });
    expect(planned.statusCode).toBe(201);
    const release = planned.json();
    await issueStore.create(openIssue(release.id));

    // Given an open issue linked to the release, the gate refuses
    const refused = await app.inject({
      method: "POST",
      url: `/releases/${release.id}/status`,
      headers: H,
      payload: { status: "released" },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain("1 linked issue(s) still open");

    // And the readiness read says exactly why
    const detail = await app.inject({ method: "GET", url: `/releases/${release.id}`, headers: H });
    expect(detail.json().readiness).toMatchObject({ openIssues: 1, ready: false });

    // When the caller forces the ship, the override is recorded — never a clean release
    const forced = await app.inject({
      method: "POST",
      url: `/releases/${release.id}/status`,
      headers: H,
      payload: { status: "released", force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().status).toBe("released");
    expect(forced.json().history.at(-1)).toMatchObject({ event: "released", detail: { forced: true } });
  });

  it("flags a watched series regressed against the previous ship, and blocks the next release on it", async () => {
    const { app, scorecardStore } = build();
    const product = await createProduct(app);
    // Given a first release shipped cleanly at a 0.9 pass rate
    const first = (
      await app.inject({
        method: "POST",
        url: `/products/${product.id}/releases`,
        headers: H,
        payload: { name: "2026.2" },
      })
    ).json();
    await scorecardStore.create(
      seriesBatch("sc-baseline", 0.9, "2026-07-01T00:00:00.000Z", { productId: product.id, seriesKey: "quality" }),
    );
    // The FIRST ship of a required series has nothing to compare against, which now blocks until someone
    // approves the bootstrap (arch-review 8 P1) — forcing it is that approval, and the decision still records
    // the candidate this ship stood on, which is what the next release anchors its baseline to.
    await app.inject({
      method: "POST",
      url: `/releases/${first.id}/status`,
      headers: H,
      payload: { status: "released", force: true },
    });
    // And a later batch that fell to 0.6
    await scorecardStore.create(
      seriesBatch("sc-latest", 0.6, "2026-08-05T00:00:00.000Z", { productId: product.id, seriesKey: "quality" }),
    );
    // When the next release tries to ship
    const next = (
      await app.inject({
        method: "POST",
        url: `/products/${product.id}/releases`,
        headers: H,
        payload: { name: "2026.3" },
      })
    ).json();
    const refused = await app.inject({
      method: "POST",
      url: `/releases/${next.id}/status`,
      headers: H,
      payload: { status: "released" },
    });
    // Then the gate names the regressed series — with the SCORECARD GATE's own verdict, not bare arithmetic
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain("quality");
    const readiness = (await app.inject({ method: "GET", url: `/releases/${next.id}`, headers: H })).json().readiness;
    expect(readiness.regressedSeries).toEqual(["quality"]);
    expect(readiness.series[0]).toMatchObject({
      key: "quality",
      verdict: "block",
      latest: { scorecardId: "sc-latest", passRate: 0.6 },
      baseline: { scorecardId: "sc-baseline", passRate: 0.9 },
    });
  });

  it("a required series that NEVER RAN blocks the ship — not evaluated is never green (arch-review 7 P0)", async () => {
    // Pre-fix, releaseReadiness read "absence of evidence as not regressed" and a product whose watched
    // series had zero evaluations shipped clean — the false green this rewrite exists to kill.
    const { app } = build();
    const product = await createProduct(app); // declares the "quality" series; no scorecard ever runs
    const release = (
      await app.inject({
        method: "POST",
        url: `/products/${product.id}/releases`,
        headers: H,
        payload: { name: "2026.3" },
      })
    ).json();
    const refused = await app.inject({
      method: "POST",
      url: `/releases/${release.id}/status`,
      headers: H,
      payload: { status: "released" },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain("quality");
    const readiness = (await app.inject({ method: "GET", url: `/releases/${release.id}`, headers: H })).json()
      .readiness;
    expect(readiness.ready).toBe(false);
    expect(readiness.series[0]).toMatchObject({ key: "quality", verdict: "not_evaluated", regressed: true });
    // Forcing the ship records the decision — including the verdict snapshot the gate saw
    const forced = await app.inject({
      method: "POST",
      url: `/releases/${release.id}/status`,
      headers: H,
      payload: { status: "released", force: true },
    });
    expect(forced.statusCode).toBe(200);
    // The ship-time DECISION, not a verdict word: which series, whether it gated, and (when a comparison
    // existed) the evidence each side stood on — the reference the next release anchors its baseline to.
    expect(forced.json().history.at(-1)?.detail).toMatchObject({
      forced: true,
      seriesDecisions: [{ key: "quality", verdict: "not_evaluated", required: true }],
    });
    expect(forced.json().history.at(-1)?.detail?.productPolicyDigest).toEqual(expect.any(String));
  });

  it("syncs the tracked services and lands the imported versions on the detail", async () => {
    const { app } = build();
    const product = await createProduct(app);
    const sync = await app.inject({ method: "POST", url: `/products/${product.id}/sync`, headers: H });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().services).toEqual([{ name: "api", imported: 1 }]);
    const versions = await app.inject({ method: "GET", url: `/products/${product.id}/versions`, headers: H });
    expect(versions.json()).toHaveLength(1);
    expect(versions.json()[0]).toMatchObject({ service: "api", version: "v1.0.0", kind: "release" });
  });

  it("proposes a monorepo's services from what the repository publishes and what its tree holds", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/products/discover",
      headers: H,
      payload: { repository: "acme/platform" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("releases");
    // A draft never reaches the sample — the preview counts what an import would actually bring.
    expect(body.versions.map((v: { name: string }) => v.name)).toEqual(["api-v1.2.0", "web-v3.1.0"]);
    expect(body.packages.map((p: { path: string }) => p.path)).toEqual(["apps/api", "apps/web"]);
    expect(body.suggestions).toEqual([
      expect.objectContaining({ name: "api", path: "apps/api", tagPrefix: "api-v", recommended: true }),
      expect.objectContaining({ name: "web", path: "apps/web", tagPrefix: "web-v", recommended: true }),
    ]);
  });

  it("records the composition a release ships, and refuses one naming a service the product does not track", async () => {
    const { app } = build();
    const product = await createProduct(app);
    const ghost = await app.inject({
      method: "POST",
      url: `/products/${product.id}/releases`,
      headers: H,
      payload: { name: "2026.3", components: [{ service: "ghost", version: "v1.0.0" }] },
    });
    expect(ghost.statusCode).toBe(400);

    const planned = await app.inject({
      method: "POST",
      url: `/products/${product.id}/releases`,
      headers: H,
      // A version-less row is a real plan state: the service ships, its version is not cut yet.
      payload: { name: "2026.3", components: [{ service: "api" }] },
    });
    expect(planned.statusCode).toBe(201);
    expect(planned.json().components).toEqual([{ service: "api" }]);

    const filled = await app.inject({
      method: "PATCH",
      url: `/releases/${planned.json().id}`,
      headers: H,
      payload: { components: [{ service: "api", version: "v1.0.0" }] },
    });
    expect(filled.statusCode).toBe(200);
    expect(filled.json().components).toEqual([{ service: "api", version: "v1.0.0" }]);

    // …and the ship freezes it: "which versions did 2026.3 contain" stays answerable from the release itself.
    // Forced, because this product's series has never been evaluated and not evaluated is never green — the
    // composition is recorded either way, which is exactly the point: it is a record, not a gate input.
    const shipped = await app.inject({
      method: "POST",
      url: `/releases/${planned.json().id}/status`,
      headers: H,
      payload: { status: "released", force: true },
    });
    expect(shipped.statusCode).toBe(200);
    // The ship RESOLVES the plan against the version ledger (arch-review 21 P1). Nothing was imported in this
    // test, so the honest answer is `unresolved` — recorded rather than refused, and distinct from a
    // component whose version nobody decided.
    expect(shipped.json().history.at(-1)?.detail?.components).toEqual([
      { service: "api", version: "v1.0.0", resolution: "unresolved" },
    ]);
  });

  it("reaches the furthest PLANNED release on the axis, while keeping the visible past a quarter behind now", async () => {
    const { app } = build(); // the service's clock is fixed at 2026-08-04
    const product = await createProduct(app);
    const plan = async (name: string, targetDate: string) => {
      const res = await app.inject({
        method: "POST",
        url: `/products/${product.id}/releases`,
        headers: H,
        payload: { name, targetDate },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    };
    await plan("2026.3", "2026-09-15");
    await plan("2026.4", "2026-11-20");
    const abandoned = await plan("2027.1", "2027-06-01");
    const cancelled = await app.inject({
      method: "POST",
      url: `/releases/${abandoned}/status`,
      headers: H,
      payload: { status: "cancelled" },
    });
    expect(cancelled.statusCode).toBe(200);

    const timeline = await app.inject({ method: "GET", url: `/products/${product.id}/timeline`, headers: H });
    expect(timeline.statusCode).toBe(200);
    // The window ENDS at the furthest planned target, not at `now` — a planned release the axis cannot place
    // is the one marker the whole screen exists for. A cancelled one never stretches it: nobody is working
    // toward that date, so the axis would spend its width on a span where nothing will ever be drawn.
    expect(timeline.json().window.to).toBe("2026-11-20T23:59:59.999Z");
    expect(timeline.json().window.now).toBe("2026-08-04T00:00:00.000Z");
    // …and the visible PAST is still a quarter back from NOW, never from the horizon: deriving it from `to`
    // would slide the window three months forward and silently drop the versions and batches the trend is
    // being read against.
    expect(timeline.json().window.from).toBe("2026-05-06T00:00:00.000Z");

    // A caller who names the end still gets exactly that window.
    const named = await app.inject({
      method: "GET",
      url: `/products/${product.id}/timeline?to=2026-08-01T00:00:00.000Z`,
      headers: H,
    });
    expect(named.json().window.to).toBe("2026-08-01T00:00:00.000Z");
    expect(named.json().window.from).toBe("2026-05-03T00:00:00.000Z");
  });

  it("addresses a product by its SLUG, minted from the name and unique per workspace", async () => {
    const { app } = build();
    const product = await createProduct(app);
    // The URL should read as the thing people name in conversation, so the name mints the address…
    expect(product.slug).toBe("support-copilot");

    // …and that address resolves the same record the id does (an old link never stops working).
    const bySlug = await app.inject({ method: "GET", url: "/products/support-copilot", headers: H });
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.json().id).toBe(product.id);

    // A second product wanting the same address gets its own — an address two records answer to is not one.
    const twin = await createProduct(app, { name: "Support Copilot" });
    expect(twin.slug).not.toBe(product.slug);
    expect((await app.inject({ method: "GET", url: `/products/${twin.slug}`, headers: H })).json().id).toBe(twin.id);

    // Every route that takes `:id` takes the address too — including the WRITE paths, where the resolved id
    // is what has to reach storage: a release created through the slug must still point at the product by id,
    // or the gate's own reverse queries would never find it.
    const planned = await app.inject({
      method: "POST",
      url: "/products/support-copilot/releases",
      headers: H,
      payload: { name: "2026.4" },
    });
    expect(planned.statusCode).toBe(201);
    expect(planned.json().productId).toBe(product.id);
    const synced = await app.inject({ method: "POST", url: "/products/support-copilot/sync", headers: H });
    expect(synced.statusCode).toBe(200);

    // And the slug is scoped to the workspace, exactly like every other read.
    const otherWorkspace = await app.inject({
      method: "GET",
      url: "/products/support-copilot",
      headers: { "x-everdict-tenant": "globex" },
    });
    expect(otherWorkspace.statusCode).toBe(404);
  });

  it("puts an issue on the axis when this product's own EVIDENCE is what it is about", async () => {
    // The three relationships an issue can have with a product, and only two of them are declared by a
    // person. Reading the explicit links alone drew an empty issue lane on exactly the products with the
    // most to say: a workspace files against a regression, links the batch that shows it, closes with the
    // batch that proves the fix — and never touches the product record.
    const { app, issueStore, scorecardStore } = build();
    const product = await createProduct(app);
    await scorecardStore.create(
      seriesBatch("sc-evidence", 0.7, "2026-08-01T00:00:00.000Z", { productId: product.id, seriesKey: "quality" }),
    );
    const base = openIssue("unused-release");
    await issueStore.create({
      ...base,
      id: "iss-linked",
      identifier: "ENG-2",
      links: [{ type: "scorecard", id: "sc-evidence", addedBy: "dana", addedAt: NOW }],
    });
    await issueStore.create({
      ...base,
      id: "iss-closed",
      identifier: "ENG-3",
      status: "done",
      links: [],
      // Closed BY the evidence — the half a link-only read misses, and the half that carries a resolution date.
      resolution: { at: "2026-08-02T00:00:00.000Z", by: "dana", scorecardId: "sc-evidence" },
    });

    const timeline = (await app.inject({ method: "GET", url: `/products/${product.id}/timeline`, headers: H })).json();
    const rows = [...timeline.issues].sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
    expect(rows).toMatchObject([
      { identifier: "ENG-3", via: "evidence", resolvedAt: "2026-08-02T00:00:00.000Z" },
      { identifier: "ENG-2", via: "evidence" },
    ]);
    // Both moments are on the row, which is what lets the lane draw an occurrence AND a resolution rather
    // than one undifferentiated bar.
    expect(rows[0].createdAt).toBe(NOW);
    expect(rows[0].resolvedByScorecardId).toBe("sc-evidence");
    expect(rows[1].resolvedAt).toBeUndefined();
  });

  // A DECLARATION OWES ITSELF A FIRST ANSWER. Only a genuinely new version import used to fan a series out,
  // so declaring one on a product whose history was already backfilled left its trend empty until upstream
  // shipped again — while the release gate read that same emptiness as `not_evaluated` and blocked the ship.
  it("declaring a watch series submits its first evaluation, stamped as the declaration's own", async () => {
    const { app, submittedRuns } = build();
    const product = await createProduct(app);

    expect(submittedRuns.map((run) => run.origin.seriesKey)).toEqual(["quality"]);
    expect(submittedRuns[0]?.origin.seriesTrigger).toBe("series_declared");
    // No import caused it, so it names none: "ran because of v2.1.0" and "ran while v2.1.0 was current" are
    // different claims and the trend draws them differently.
    expect(submittedRuns[0]?.origin.serviceVersion).toBeUndefined();
    expect(submittedRuns[0]?.origin.productId).toBe(product.id);
  });

  it("adding a series to an existing product seeds only the new one", async () => {
    const { app, submittedRuns } = build();
    const product = await createProduct(app);
    submittedRuns.length = 0;

    const res = await app.inject({
      method: "PATCH",
      url: `/products/${product.id}`,
      headers: H,
      payload: {
        series: [
          {
            key: "quality",
            label: "Quality",
            dataset: { id: "support-cases" },
            harness: { id: "copilot" },
            judges: [],
          },
          { key: "cost", label: "Cost", dataset: { id: "support-cases" }, harness: { id: "copilot" }, judges: [] },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(submittedRuns.map((run) => run.origin.seriesKey)).toEqual(["cost"]);
  });

  // The key is the TREND's identity and survives every edit, which is exactly why it cannot say whether the
  // evidence under it still answers the question: re-pointing a series at another dataset keeps its chart
  // while every point on it now answers something else (the gate calls that `contract_stale`).
  it("re-pointing a series at another dataset re-seeds it, while renaming its label does not", async () => {
    const { app, submittedRuns } = build();
    const product = await createProduct(app);
    submittedRuns.length = 0;

    const relabel = await app.inject({
      method: "PATCH",
      url: `/products/${product.id}`,
      headers: H,
      payload: {
        series: [
          {
            key: "quality",
            label: "Answer quality",
            dataset: { id: "support-cases" },
            harness: { id: "copilot" },
            judges: [],
          },
        ],
      },
    });
    expect(relabel.statusCode).toBe(200);
    expect(submittedRuns).toEqual([]);

    const repoint = await app.inject({
      method: "PATCH",
      url: `/products/${product.id}`,
      headers: H,
      payload: {
        series: [
          {
            key: "quality",
            label: "Answer quality",
            dataset: { id: "escalation-cases" },
            harness: { id: "copilot" },
            judges: [],
          },
        ],
      },
    });
    expect(repoint.statusCode).toBe(200);
    expect(submittedRuns.map((run) => run.origin.seriesKey)).toEqual(["quality"]);
    expect(submittedRuns[0]?.dataset.id).toBe("escalation-cases");
  });

  it("evaluates the watch series on demand — sync's counterpart on the quality axis", async () => {
    const { app, submittedRuns } = build();
    const product = await createProduct(app);
    submittedRuns.length = 0;

    const res = await app.inject({ method: "POST", url: `/products/${product.id}/series/run`, headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ triggered: ["sc-auto-1"], failedSeries: [] });
    expect(submittedRuns[0]?.origin.seriesTrigger).toBe("manual");
    expect(submittedRuns[0]?.submittedBy).toBe("dev"); // the person who asked, not the standing author
  });

  it("runs only the series named, and refuses a key the product does not declare", async () => {
    const { app, submittedRuns } = build();
    const product = await createProduct(app);
    submittedRuns.length = 0;

    const ghost = await app.inject({
      method: "POST",
      url: `/products/${product.id}/series/run`,
      headers: H,
      payload: { keys: ["ghost"] },
    });
    // Not an empty fan-out: "run the ghost series" answered by running nothing is indistinguishable from a
    // series that submitted and produced no batch.
    expect(ghost.statusCode).toBe(404);
    expect(submittedRuns).toEqual([]);

    const named = await app.inject({
      method: "POST",
      url: `/products/${product.id}/series/run`,
      headers: H,
      payload: { keys: ["quality"] },
    });
    expect(named.statusCode).toBe(200);
    expect(submittedRuns.map((run) => run.origin.seriesKey)).toEqual(["quality"]);
  });

  // Auto-eval governs the AUTOMATIC paths (the import fan-out, the declaration seed). A member pressing the
  // button is not one of them, and a control that silently does nothing is worse than no control.
  it("runs on demand even with auto-eval switched off, and seeds nothing while it is off", async () => {
    const { app, submittedRuns } = build();
    const product = await createProduct(app, { autoEval: { enabled: false } });
    expect(submittedRuns).toEqual([]);

    const res = await app.inject({ method: "POST", url: `/products/${product.id}/series/run`, headers: H });
    expect(res.statusCode).toBe(200);
    expect(submittedRuns.map((run) => run.origin.seriesKey)).toEqual(["quality"]);
  });

  it("refuses to run the series of a product that declares none", async () => {
    const { app } = build();
    const product = await createProduct(app, { series: [] });
    const res = await app.inject({ method: "POST", url: `/products/${product.id}/series/run`, headers: H });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a release watching a series the product never declared", async () => {
    const { app } = build();
    const product = await createProduct(app);
    const res = await app.inject({
      method: "POST",
      url: `/products/${product.id}/releases`,
      headers: H,
      payload: { name: "2026.3", seriesKeys: ["ghost"] },
    });
    expect(res.statusCode).toBe(400);
  });
});
