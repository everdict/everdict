import type { ProductSeries } from "@everdict/contracts";
import { InMemoryProductVersionStore, PgProductVersionStore } from "@everdict/db";
import {
  type ResolvedSeriesContract,
  type SeriesContractResolution,
  seriesContractDigest,
  seriesContractFromManifest,
} from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-45 · 46 · 47 · 48.
//
// A SERIES KEY IS NOT AN EVALUATION CONTRACT, AND A SERVICE NAME IS NOT A VERSION STREAM. Both identities
// were introduced in the same generation of work, and both were introduced with a defect that only a real
// database (or a nested `latest`) reveals — which is exactly why they are certified here rather than
// asserted in a unit test.
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

const plan = (over: Partial<ResolvedSeriesContract> = {}): ResolvedSeriesContract => ({
  dataset: { id: "support", version: "1.0.0" },
  harness: { id: "copilot", version: "1.0.0" },
  judges: [{ id: "quality", version: "1.0.0" }],
  ...over,
});

describeTrust("TRUST-45 — a nested `latest` moving changes the series contract identity", () => {
  it("the same harness@version under a different resolved MODEL is a different question", () => {
    // The failure this closes: `harness@1` is a DOCUMENT, and that document may name `model: {ref}` with no
    // version. Two runs of a byte-identical series declaration can therefore execute under different models
    // while every id/version above reads held — which is precisely why the scorecard manifest seals the
    // closure. A Product-side identity that stopped at the top documents would have been a second, weaker
    // answer to a question the platform had already answered properly.
    const yesterday = seriesContractDigest(plan({ harnessModel: "main-model@3" }));
    const today = seriesContractDigest(plan({ harnessModel: "main-model@4" }));
    expect(today).not.toBe(yesterday);
  });

  it("a judge's nested rubric/model moving changes it too — the closure is the identity, not the top spec", () => {
    const a = seriesContractDigest(
      plan({ judgeClosure: [{ id: "quality", version: "1.0.0", model: "m@1", rubric: "r@1" }] }),
    );
    const b = seriesContractDigest(
      plan({ judgeClosure: [{ id: "quality", version: "1.0.0", model: "m@1", rubric: "r@2" }] }),
    );
    expect(a).not.toBe(b);
  });

  it("…and stays STABLE under things that are not the question: judge order, key order", () => {
    // An identity that moves on a reorder would mark every harmless edit as a contract change, which trains
    // people to ignore the signal — the failure mode a too-broad guard always has.
    const one = seriesContractDigest(
      plan({
        judges: [
          { id: "safety", version: "1.0.0" },
          { id: "quality", version: "1.0.0" },
        ],
        serviceModels: { web: "m@1", api: "m@2" },
      }),
    );
    const two = seriesContractDigest(
      plan({
        judges: [
          { id: "quality", version: "1.0.0" },
          { id: "safety", version: "1.0.0" },
        ],
        serviceModels: { api: "m@2", web: "m@1" },
      }),
    );
    expect(one).toBe(two);
  });
});

describeTrust("TRUST-47/48 — the stream key round-trips through real Postgres, and two streams coexist", () => {
  let pg: TrustPg;

  const openPg = async (): Promise<TrustPg> => {
    pg ??= await openTrustPg();
    return pg;
  };

  it.skipIf(!TRUST_PG_ENABLED)("stores a stream key verbatim — the value must be TEXT-safe", async () => {
    // TRUST-47. The first implementation joined the coordinates on U+0000 "because no coordinate can contain
    // it" — true, and unstorable: Postgres rejects NUL in text outright
    // (`invalid byte sequence for encoding "UTF8": 0x00`), so every version import failed at the driver. A
    // separator chosen for what it excludes is a separator chosen without asking where the value goes, and
    // no in-memory test could ever have caught it.
    const { client } = await openPg();
    const store = new PgProductVersionStore(client);
    const productId = trustId("prod-stream");
    await client.query(
      `INSERT INTO everdict_products (id, tenant, name, services, series, auto_eval, history, created_by, created_at, updated_at)
       VALUES ($1,'trust','Streamed','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'[]'::jsonb,'dana',now(),now())`,
      [productId],
    );
    const streamKey = JSON.stringify(["", "acme/api", "releases", ""]);
    const row = (id: string, key: string) => ({
      id,
      tenant: "trust",
      productId,
      service: "api",
      version: "v1.0.0",
      streamKey: key,
      kind: "release" as const,
      prerelease: false,
      publishedAt: "2026-01-01T00:00:00.000Z",
      importedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(store.create(row(trustId("v-a"), streamKey))).resolves.toBe(true);
    const back = await store.list("trust", { productId });
    expect(back[0]?.streamKey).toBe(streamKey); // verbatim, not mangled

    // TRUST-48: the SAME (service, version) from a DIFFERENT stream is a different release and coexists.
    // This only holds once mig 0157 has dropped mig 0138's name-scoped UNIQUE — while both constraints
    // stood, the older one won and this row vanished as "already known".
    const other = JSON.stringify(["", "acme/api-next", "releases", ""]);
    await expect(store.create(row(trustId("v-b"), other))).resolves.toBe(true);
    expect(await store.list("trust", { productId })).toHaveLength(2);
    // …and the stream-scoped read returns exactly one of them.
    expect(await store.list("trust", { productId, service: "api", streamKey })).toHaveLength(1);
    // Re-importing the same (stream, version) is still not news.
    await expect(store.create(row(trustId("v-c"), streamKey))).resolves.toBe(false);
    await client.query("DELETE FROM everdict_products WHERE id=$1", [productId]);
  });

  it("the in-memory pair answers identically — the two stores must not disagree on identity", async () => {
    const store = new InMemoryProductVersionStore();
    const row = (id: string, key: string) => ({
      id,
      tenant: "trust",
      productId: "prod-1",
      service: "api",
      version: "v1.0.0",
      streamKey: key,
      kind: "release" as const,
      prerelease: false,
      publishedAt: "2026-01-01T00:00:00.000Z",
      importedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await store.create(row("a", JSON.stringify(["", "acme/api", "releases", ""])))).toBe(true);
    expect(await store.create(row("b", JSON.stringify(["", "acme/api-next", "releases", ""])))).toBe(true);
    expect(await store.list("trust", { productId: "prod-1" })).toHaveLength(2);
  });
});

describeTrust("TRUST-43 — an unresolvable series contract is never green", () => {
  const SERIES: ProductSeries = {
    key: "quality",
    label: "Quality",
    dataset: { id: "support" },
    harness: { id: "copilot" },
    judges: [],
    allowNoBaseline: true,
  };

  it("a required series whose current definition cannot be read BLOCKS, whatever the evidence says", async () => {
    // The collapse this closes: `undefined` travelled from "we could not resolve it" to "do not run the
    // freshness check", in the one place that decides whether a release ships. A registry outage or a
    // deleted dataset made stale evidence pass — silently, in the direction of green.
    const { ProductService } = await import("@everdict/application-control");
    const {
      InMemoryProductStore,
      InMemoryReleaseStore,
      InMemoryProductVersionStore: Versions,
    } = await import("@everdict/db");
    let n = 0;
    const service = new ProductService({
      store: new InMemoryProductStore(),
      releases: new InMemoryReleaseStore(),
      versions: new Versions(),
      // The dataset this series names was deleted — the resolver says so instead of answering `undefined`.
      resolveSeriesContract: async (): Promise<SeriesContractResolution> => ({
        status: "unresolvable",
        reason: "dataset 'support' has no versions in this workspace",
      }),
      newId: () => `t43-${n++}`,
      now: () => "2026-08-04T00:00:00.000Z",
    });
    const product = await service.create({
      tenant: "acme",
      createdBy: "release-captain",
      name: "Support Copilot",
      series: [SERIES],
    });
    const release = await service.createRelease({
      tenant: "acme",
      createdBy: "release-captain",
      productId: product.id,
      name: "2026.3",
    });
    const readiness = (await service.releaseDetail("acme", release.id)).readiness;
    expect(readiness.series[0]).toMatchObject({ verdict: "contract_unverifiable", regressed: true });
    expect(readiness.ready).toBe(false);
    await expect(
      service.setReleaseStatus("acme", release.id, { status: "released" }, { subject: "release-captain" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describeTrust("TRUST-56/57/58/63 — the PRODUCTION resolver, not a hand-written plan", () => {
  // TRUST-45/46 above certify the digest FUNCTION over hand-written plans. That is a weaker statement than it
  // looks: it proves the identity moves when the plan moves, and says nothing about whether the resolver
  // actually puts the moving facet INTO the plan. The resolver this replaced passed TRUST-45 while being
  // blind to service models and delegated judge harnesses entirely — the fixture supplied by hand exactly the
  // facet production never filled in. These drive `resolveSeriesContract` itself.
  const series: ProductSeries = {
    key: "quality",
    dataset: { id: "support" },
    harness: { id: "copilot" },
    judges: [{ id: "grader" }],
  } as unknown as ProductSeries;

  // A registry pair whose `latest` can be moved between resolutions, which is the whole failure mode: no id
  // and no version above the binding changes at all. `shadowedDataset`/`shadowedHarness` model the OTHER
  // shape — a tenant-local registration over a `_shared` one at the SAME version, where not even a nested
  // ref moves and the only thing that differs is the document.
  const world = (
    over: {
      serviceModel?: string;
      delegate?: string;
      shadowed?: boolean;
      shadowedDataset?: boolean;
      shadowedHarness?: boolean;
    } = {},
  ) => ({
    datasets: {
      versions: async () => ["1.0.0"],
      get: async () => ({
        id: "support",
        version: "1.0.0",
        cases: [{ id: "c1", task: over.shadowedDataset ? "do the OTHER thing" : "do the thing" }],
      }),
    },
    harnesses: {
      versions: async () => ["1.0.0"],
      get: async (_t: string, id: string) =>
        id === "grader-agent"
          ? { version: over.delegate ?? "4.0.0" }
          : {
              kind: "service",
              id: "copilot",
              version: "1.0.0",
              // The script differs; the model closure is byte-identical either way. That combination is
              // exactly what a contract stopping at id + version + closure could not see.
              command: over.shadowedHarness ? "run --v2 {{task}}" : "run {{task}}",
              services: [{ name: "api", image: "img", model: { ref: "agent-model" } }],
            },
    },
    judges: {
      versions: async () => ["1.0.0"],
      // The SHADOW: a tenant-local `grader@1.0.0` registered over the `_shared` one. Same id, same version
      // string — a DIFFERENT document, which the owner-first registry fallback resolves to instead.
      get: async (_t: string, _id: string, version: string) => ({
        kind: "harness",
        id: "grader",
        version,
        harness: { id: "grader-agent", version: "latest" },
        tags: over.shadowed ? ["tenant-local"] : [],
      }),
    },
    resolveModelBinding: async (_t: string, b: { ref: string }) => `${b.ref}@${over.serviceModel ?? "7.0.0"}`,
  });

  const resolve = async (over?: Parameters<typeof world>[0]): Promise<SeriesContractResolution> => {
    const { resolveSeriesContract } = await import("@everdict/application-control");
    // biome-ignore lint/suspicious/noExplicitAny: a trust fixture stands in for four registries at once
    return resolveSeriesContract(world(over) as any, "acme", series);
  };

  const digestOf = async (over?: Parameters<typeof world>[0]): Promise<string> => {
    const r = await resolve(over);
    if (r.status !== "resolved") throw new Error(`expected resolved, got ${r.status}`);
    return r.digest;
  };

  it("TRUST-56 — a SERVICE harness's nested model `latest` moving changes the contract identity", async () => {
    expect(await digestOf({ serviceModel: "8.0.0" })).not.toBe(await digestOf());
  });

  it("TRUST-57 — a harness judge's DELEGATED agent moving changes it too", async () => {
    // The entire agent rendering the verdict is swapped, and `judge@1.0.0` reads held throughout.
    expect(await digestOf({ delegate: "5.0.0" })).not.toBe(await digestOf());
  });

  it("TRUST-58 — a tenant-local `x@1` shadowing the `_shared` `x@1` changes the evaluation identity", async () => {
    // The hard case, and the reason the closure carries `specDigest`: the registry resolves owner-first with a
    // `_shared` fallback, so registering a LOCAL judge at the very same version substitutes a different
    // document with the id AND the version string both reading held. Nothing above the bytes moves. An
    // identity that stopped at id+version would call this the same question and let a workspace silently
    // replace the judge behind a green trend.
    expect(await digestOf({ shadowed: true })).not.toBe(await digestOf());
  });

  it("TRUST-65 — a shadowed HARNESS document changes it, even with an identical model closure", async () => {
    // `agent@1` is a NAME. The registry resolves it owner-first over `_shared`, so a workspace registering its
    // own `agent@1` substitutes different bytes — different script, environment, service topology — while the
    // id, the version string AND (here, deliberately) the whole resolved model closure all read held.
    expect(await digestOf({ shadowedHarness: true })).not.toBe(await digestOf());
  });

  it("TRUST-66 — a shadowed DATASET changes it: the tasks are the question", async () => {
    // The sharper half. A shadowed dataset can change every case's task, environment, timeout and default
    // graders, and until the contract carried the case bundle's digest `support@1 == support@1` was a
    // structural blind spot in the comparison that decides whether a release ships.
    expect(await digestOf({ shadowedDataset: true })).not.toBe(await digestOf());
  });

  it("TRUST-63 — the resolver's contract IS the manifest's, projected: one vocabulary, certified equal", async () => {
    // The strongest form of "one answer": take what the resolver produced, seal an execution manifest with the
    // same facts, project the manifest back, and require the digests to be identical. If either side ever
    // grows a facet the other lacks, this fails — which is the only way the two can be kept from drifting
    // apart again by anything other than someone remembering.
    const resolution = await resolve();
    if (resolution.status !== "resolved") throw new Error(resolution.status);
    const c = resolution.contract;
    const manifest = {
      dataset: c.dataset, // digest included — the projection must carry it, which is what P0-2 fixed
      harness: {
        ...c.harness,
        ...(c.harnessModel !== undefined ? { model: c.harnessModel } : {}),
        ...(c.serviceModels !== undefined ? { serviceModels: c.serviceModels } : {}),
        ...(c.harnessModelDigest !== undefined ? { modelDigest: c.harnessModelDigest } : {}),
        ...(c.serviceModelDigests !== undefined ? { serviceModelDigests: c.serviceModelDigests } : {}),
      },
      judges: c.judgeClosure,
      ...(c.judgeRun !== undefined ? { judgeRun: c.judgeRun } : {}),
    };
    expect(seriesContractDigest(seriesContractFromManifest(manifest))).toBe(resolution.digest);
  });
});
