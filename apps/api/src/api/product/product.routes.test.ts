import { ProductService, ProductVersionSync, RunService } from "@everdict/application-control";
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
  const productService = new ProductService({
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
          return [
            {
              tagName: "v1.0.0",
              url: "https://github.com/acme/api/releases/v1.0.0",
              draft: false,
              prerelease: false,
              publishedAt: "2026-08-01T00:00:00.000Z",
            },
          ];
        },
        async listTags() {
          return [];
        },
        async commitDate() {
          return undefined;
        },
      }),
    },
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    productService,
    productVersionSync,
  });
  return { app, issueStore, scorecardStore };
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
    await app.inject({
      method: "POST",
      url: `/releases/${first.id}/status`,
      headers: H,
      payload: { status: "released" },
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
    expect(forced.json().history.at(-1)?.detail).toMatchObject({
      forced: true,
      seriesVerdicts: [{ key: "quality", verdict: "not_evaluated" }],
    });
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
