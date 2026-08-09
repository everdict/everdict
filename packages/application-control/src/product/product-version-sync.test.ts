import type { ProductRecord, ProductServiceVersionRecord, ReleaseRecord } from "@everdict/contracts";
import { Product, Release } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type {
  OutboxEvent,
  ProductListFilter,
  ProductStore,
  ProductVersionListFilter,
  ProductVersionStore,
  ReleaseListFilter,
  ReleaseStore,
} from "../index.js";
import type { GithubRelease, GithubTag, GithubVersionReader } from "../ports/github-repo-writer.js";
import { ProductVersionSync, type SeriesRunSubmitter } from "./product-version-sync.js";

const NOW = "2026-08-08T00:00:00.000Z";

// Hand-rolled port fakes (application-control cannot import @everdict/db — that would reverse the layer).
class FakeProductStore implements ProductStore {
  constructor(private record: ProductRecord) {}
  async create(): Promise<void> {}
  async get(tenant: string, id: string): Promise<ProductRecord | undefined> {
    return this.record.tenant === tenant && this.record.id === id ? this.record : undefined;
  }
  async list(_tenant: string, _filter?: ProductListFilter): Promise<ProductRecord[]> {
    return [this.record];
  }
  async listAll(): Promise<ProductRecord[]> {
    return [this.record];
  }
  async update(_tenant: string, _id: string, patch: Partial<ProductRecord>): Promise<ProductRecord | undefined> {
    this.record = { ...this.record, ...patch };
    return this.record;
  }
  async remove(): Promise<void> {}
  async removeAggregate(): Promise<{ releases: number; versions: number }> {
    return { releases: 0, versions: 0 };
  }
  current(): ProductRecord {
    return this.record;
  }
}

class FakeReleaseStore implements ReleaseStore {
  constructor(private readonly rows: ReleaseRecord[] = []) {}
  async create(record: ReleaseRecord): Promise<void> {
    this.rows.push(record);
  }
  async get(tenant: string, id: string): Promise<ReleaseRecord | undefined> {
    return this.rows.find((row) => row.tenant === tenant && row.id === id);
  }
  async list(tenant: string, filter?: ReleaseListFilter): Promise<ReleaseRecord[]> {
    return this.rows.filter(
      (row) =>
        row.tenant === tenant &&
        (filter?.productId === undefined || row.productId === filter.productId) &&
        (filter?.status === undefined || row.status === filter.status),
    );
  }
  async update(): Promise<ReleaseRecord | undefined> {
    return undefined;
  }
  async remove(): Promise<void> {}
}

class FakeVersionStore implements ProductVersionStore {
  readonly rows: ProductServiceVersionRecord[] = [];
  readonly events: OutboxEvent[] = [];
  async create(record: ProductServiceVersionRecord, events?: OutboxEvent[]): Promise<boolean> {
    const exists = this.rows.some(
      (row) =>
        row.tenant === record.tenant &&
        row.productId === record.productId &&
        row.service === record.service &&
        row.version === record.version,
    );
    if (exists) return false;
    this.rows.push(record);
    if (events) this.events.push(...events);
    return true;
  }
  async list(tenant: string, filter: ProductVersionListFilter): Promise<ProductServiceVersionRecord[]> {
    return this.rows.filter(
      (row) =>
        row.tenant === tenant &&
        row.productId === filter.productId &&
        (filter.service === undefined || row.service === filter.service),
    );
  }
  async removeForProduct(): Promise<void> {}
}

function reader(releases: GithubRelease[], tags: GithubTag[] = []): GithubVersionReader {
  return {
    async listReleases() {
      return releases;
    },
    async listTags() {
      return tags;
    },
    async commitDate() {
      return "2026-08-05T00:00:00.000Z";
    },
  };
}

function productRecord(over?: Partial<ProductRecord>): ProductRecord {
  return {
    ...Product.newProduct({
      id: "prod-1",
      tenant: "acme",
      name: "Support Copilot",
      services: [{ name: "api", repository: "acme/copilot-api", source: "releases" }],
      series: [
        {
          key: "quality",
          label: "Quality",
          dataset: { id: "support-cases" },
          harness: { id: "copilot" },
          judges: [{ id: "helpfulness" }],
        },
      ],
      createdBy: "dana",
      now: NOW,
    }),
    ...over,
  };
}

const ghRelease = (tag: string, publishedAt: string): GithubRelease => ({
  tagName: tag,
  url: `https://github.com/acme/copilot-api/releases/${tag}`,
  draft: false,
  prerelease: false,
  publishedAt,
});

function build(over?: {
  product?: ProductRecord;
  releases?: ReleaseRecord[];
  ghReleases?: GithubRelease[];
  ghTags?: GithubTag[];
}) {
  const products = new FakeProductStore(over?.product ?? productRecord());
  const releases = new FakeReleaseStore(over?.releases ?? []);
  const versions = new FakeVersionStore();
  const submitted: Array<Parameters<SeriesRunSubmitter>[0]> = [];
  const sync = new ProductVersionSync({
    products,
    releases,
    versions,
    tokens: {
      async tokenForRepository() {
        return { token: "ghs_test" };
      },
    },
    readers: { for: () => reader(over?.ghReleases ?? [], over?.ghTags ?? []) },
    submitSeriesRun: async (input) => {
      submitted.push(input);
      return { id: `sc-${submitted.length}` };
    },
    now: () => NOW,
  });
  return { sync, products, versions, submitted };
}

describe("ProductVersionSync — GitHub pull into the insert-once ledger", () => {
  it("backfills the timeline's past silently — no facts, no auto-eval — and stamps the watermark", async () => {
    // Given a service that has never synced and two historical releases
    const { sync, products, versions, submitted } = build({
      ghReleases: [ghRelease("v1.0.0", "2026-01-01T00:00:00.000Z"), ghRelease("v1.1.0", "2026-03-01T00:00:00.000Z")],
    });
    // When the first sync runs
    const result = await sync.sync("acme", "prod-1", { subject: "dana" });
    // Then both versions land, nothing is announced, nothing runs
    expect(result.services).toEqual([{ name: "api", imported: 2 }]);
    expect(versions.rows).toHaveLength(2);
    expect(versions.events).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    expect(products.current().services[0]?.sync?.syncedAt).toBe(NOW);
  });

  it("announces a genuinely new version and runs each watched series once, stamped with the trigger", async () => {
    // Given a service that has synced before
    const synced = productRecord();
    const { sync, versions, submitted } = build({
      product: {
        ...synced,
        services: [{ ...synced.services[0], sync: { syncedAt: "2026-08-01T00:00:00.000Z" } } as never],
      },
      ghReleases: [ghRelease("v1.2.0", "2026-08-07T00:00:00.000Z")],
    });
    // When the sync finds one new release
    const result = await sync.sync("acme", "prod-1", { subject: "dana" });
    // Then the fact rides the insert and one batch per series is submitted with product provenance
    expect(versions.events.map((event) => event.kind)).toEqual(["product.service_version_imported"]);
    expect(versions.events[0]?.payload).toMatchObject({ service: "api", version: "v1.2.0" });
    expect(result.triggered).toEqual(["sc-1"]);
    expect(submitted[0]).toMatchObject({
      tenant: "acme",
      submittedBy: "dana",
      dataset: { id: "support-cases" },
      harness: { id: "copilot" },
      origin: { source: "product", productId: "prod-1", seriesKey: "quality", serviceVersion: "api@v1.2.0" },
    });
  });

  it("scopes the auto-eval to the active planned release's series selection and stamps its id", async () => {
    const synced = productRecord({
      series: [
        { key: "quality", label: "Quality", dataset: { id: "d" }, harness: { id: "h" }, judges: [] },
        { key: "latency", label: "Latency", dataset: { id: "d2" }, harness: { id: "h" }, judges: [] },
      ],
    });
    const planned = Release.newRelease({
      id: "rel-1",
      tenant: "acme",
      productId: "prod-1",
      name: "2026.3",
      seriesKeys: ["latency"],
      productSeriesKeys: ["quality", "latency"],
      createdBy: "dana",
      now: NOW,
    });
    const { sync, submitted } = build({
      product: {
        ...synced,
        services: [{ ...synced.services[0], sync: { syncedAt: "2026-08-01T00:00:00.000Z" } } as never],
      },
      releases: [planned],
      ghReleases: [ghRelease("v1.2.0", "2026-08-07T00:00:00.000Z")],
    });
    await sync.sync("acme", "prod-1", { subject: "dana" });
    expect(submitted.map((entry) => entry.origin.seriesKey)).toEqual(["latency"]);
    expect(submitted[0]?.origin.releaseId).toBe("rel-1");
  });

  it("re-syncing imports nothing new and therefore fires nothing — the ledger is the dedup", async () => {
    const synced = productRecord();
    const { sync, submitted, versions } = build({
      product: {
        ...synced,
        services: [{ ...synced.services[0], sync: { syncedAt: "2026-08-01T00:00:00.000Z" } } as never],
      },
      ghReleases: [ghRelease("v1.2.0", "2026-08-07T00:00:00.000Z")],
    });
    await sync.sync("acme", "prod-1", { subject: "dana" });
    const again = await sync.sync("acme", "prod-1", { subject: "dana" });
    expect(again.services).toEqual([{ name: "api", imported: 0 }]);
    expect(versions.rows).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });

  it("keeps only tags matching the service's prefix, dating them by their commit", async () => {
    const tagged = productRecord();
    const { sync, versions } = build({
      product: {
        ...tagged,
        services: [{ name: "api", repository: "acme/mono", source: "tags", tagPrefix: "api-" } as never],
      },
      ghTags: [
        { name: "api-v1.0.0", sha: "a1" },
        { name: "web-v2.0.0", sha: "b2" },
      ],
    });
    const result = await sync.sync("acme", "prod-1", { subject: "dana" });
    expect(result.services).toEqual([{ name: "api", imported: 1 }]);
    expect(versions.rows[0]).toMatchObject({
      version: "api-v1.0.0",
      kind: "tag",
      sha: "a1",
      publishedAt: "2026-08-05T00:00:00.000Z",
    });
  });

  it("soft-fails one unreachable repository — the error is recorded, the sync itself succeeds", async () => {
    const twoServices = productRecord({
      services: [
        { name: "api", repository: "acme/copilot-api", source: "releases" },
        { name: "web", repository: "acme/copilot-web", source: "releases" },
      ],
    });
    const products = new FakeProductStore(twoServices);
    const versions = new FakeVersionStore();
    const sync = new ProductVersionSync({
      products,
      releases: new FakeReleaseStore(),
      versions,
      tokens: {
        async tokenForRepository(_ws, repository) {
          if (repository === "acme/copilot-web") throw new Error("no installation covers acme/copilot-web");
          return { token: "ghs_test" };
        },
      },
      readers: { for: () => reader([ghRelease("v1.0.0", "2026-08-01T00:00:00.000Z")]) },
      now: () => NOW,
    });
    const result = await sync.sync("acme", "prod-1", { subject: "dana" });
    expect(result.services[0]).toEqual({ name: "api", imported: 1 });
    expect(result.services[1]).toMatchObject({ name: "web", imported: 0 });
    expect(result.services[1]?.error).toContain("copilot-web");
    expect(products.current().services[1]?.sync?.lastError?.message).toContain("copilot-web");
    // And the reachable service's watermark still landed
    expect(products.current().services[0]?.sync?.syncedAt).toBe(NOW);
  });
});
