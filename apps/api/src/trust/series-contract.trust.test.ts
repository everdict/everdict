import type { ProductSeries } from "@everdict/contracts";
import { InMemoryProductVersionStore, PgProductVersionStore } from "@everdict/db";
import { type ResolvedSeriesContract, type SeriesContractResolution, seriesContractDigest } from "@everdict/domain";
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
