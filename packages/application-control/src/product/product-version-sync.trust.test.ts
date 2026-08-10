import type { ProductRecord, ProductServiceVersionRecord, ReleaseRecord } from "@everdict/contracts";
import { Product } from "@everdict/domain";
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
import type { GithubRelease, GithubVersionReader } from "../ports/github-repo-writer.js";
import { ProductVersionSync, type SeriesRunSubmitter } from "./product-version-sync.js";

// Trust suite (docs/trust-certification.md) — TRUST-59 · TRUST-60 · TRUST-68.
//
// A CAUSE IS A FACT ABOUT THE WORLD THAT NOW EXISTS, AND A BOUNDED READ IS NOT A HISTORY.
//
// Both scenarios are about the sync's honesty rather than its correctness in the narrow sense: in each, the
// evaluation it produces (or the rows it imports) would look perfectly fine. What would be false is the
// SENTENCE the timeline tells about them — "we ran this because repo-A shipped" for a product that no longer
// watches repo-A, and "this is the service's history" for a read that stopped at a ceiling. A system of record
// that misattributes causes or silently truncates history stops being one.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const NOW = "2026-08-09T00:00:00.000Z";

class FakeProductStore implements ProductStore {
  // `reads` lets a scenario hand back a DIFFERENT product on the post-import read — which is exactly what a
  // member repointing the service mid-sync does.
  constructor(private readonly reads: ProductRecord[]) {}
  private at = 0;
  async create(): Promise<void> {}
  async get(): Promise<ProductRecord | undefined> {
    const record = this.reads[Math.min(this.at, this.reads.length - 1)];
    this.at += 1;
    return record;
  }
  async list(_tenant: string, _filter?: ProductListFilter): Promise<ProductRecord[]> {
    return this.reads.slice(0, 1);
  }
  async listAll(): Promise<ProductRecord[]> {
    return this.reads.slice(0, 1);
  }
  async update(): Promise<ProductRecord | undefined> {
    return this.reads[this.reads.length - 1];
  }
  async remove(): Promise<void> {}
  async removeAggregate(): Promise<{ releases: number; versions: number }> {
    return { releases: 0, versions: 0 };
  }
}

class FakeReleaseStore implements ReleaseStore {
  async create(): Promise<void> {}
  async get(): Promise<ReleaseRecord | undefined> {
    return undefined;
  }
  async list(_tenant: string, _filter?: ReleaseListFilter): Promise<ReleaseRecord[]> {
    return [];
  }
  async update(): Promise<ReleaseRecord | undefined> {
    return undefined;
  }
  async remove(): Promise<void> {}
}

class FakeVersionStore implements ProductVersionStore {
  rows: ProductServiceVersionRecord[] = [];
  async create(record: ProductServiceVersionRecord, _events?: OutboxEvent[]): Promise<boolean> {
    if (this.rows.some((r) => r.streamKey === record.streamKey && r.version === record.version)) return false;
    this.rows.push(record);
    return true;
  }
  async list(_tenant: string, filter?: ProductVersionListFilter): Promise<ProductServiceVersionRecord[]> {
    const rows = this.rows.filter(
      (r) =>
        (filter?.service === undefined || r.service === filter.service) &&
        (filter?.streamKey === undefined || r.streamKey === filter.streamKey),
    );
    return filter?.limit === undefined ? rows : rows.slice(0, filter.limit);
  }
  async remove(): Promise<void> {}
  async removeForProduct(): Promise<void> {}
}

const ghRelease = (tag: string): GithubRelease => ({
  tagName: tag,
  url: `https://github.com/acme/${tag}`,
  draft: false,
  prerelease: false,
  publishedAt: "2026-08-08T00:00:00.000Z",
});

const productAt = (repository: string, synced: boolean): ProductRecord =>
  Product.newProduct({
    id: "prod-1",
    tenant: "acme",
    name: "Support Copilot",
    services: [
      {
        name: "api",
        repository,
        source: "releases",
        ...(synced ? { sync: { syncedAt: "2026-08-01T00:00:00.000Z" } } : {}),
      } as never,
    ],
    series: [
      {
        key: "quality",
        label: "Quality",
        dataset: { id: "support-cases" },
        harness: { id: "copilot" },
        judges: [],
      },
    ],
    createdBy: "dana",
    now: NOW,
  });

function build(reads: ProductRecord[], reader: GithubVersionReader) {
  const versions = new FakeVersionStore();
  const submitted: Array<Parameters<SeriesRunSubmitter>[0]> = [];
  const sync = new ProductVersionSync({
    products: new FakeProductStore(reads),
    releases: new FakeReleaseStore(),
    versions,
    tokens: {
      async tokenForRepository() {
        return { token: "ghs_test" };
      },
    },
    readers: { for: () => reader },
    submitSeriesRun: async (input) => {
      submitted.push(input);
      return { id: `sc-${submitted.length}` };
    },
    now: () => NOW,
  });
  return { sync, versions, submitted };
}

describeTrust("TRUST-59 — an arrival on a stream the product no longer watches is not a cause", () => {
  it("imports repo-A's release and triggers NOTHING once the service has been repointed to repo-B", async () => {
    // Given a sync that opens on repo-A, and a member who repoints "api" to repo-B while the network read is
    // in flight. The imported row is real and stays — the ledger is insert-once and repo-A did ship. What must
    // not happen is the fan-out: running the CURRENT series and stamping it
    // `serviceVersion: api@v9.0.0, because repo-A released` would attribute the evaluation to a stream this
    // product does not watch. The evaluation itself would be perfectly valid; the sentence about why it exists
    // would be false, and the timeline is nothing but those sentences.
    const reader: GithubVersionReader = {
      async listReleases() {
        return { rows: [ghRelease("v9.0.0")], complete: true };
      },
      async listTags() {
        return { rows: [], complete: true };
      },
      async commitDate() {
        return undefined;
      },
    };
    const { sync, versions, submitted } = build(
      // read 1 = the world the sync opened on; every later read = after the repoint
      [productAt("acme/copilot-api", true), productAt("acme/copilot-next", true)],
      reader,
    );
    const result = await sync.sync("acme", "prod-1", { subject: "dana" });
    expect(versions.rows).toHaveLength(1); // the arrival is recorded — it happened
    expect(result.triggered).toEqual([]); // …and causes nothing for a product that moved on
    expect(submitted).toEqual([]);
  });

  it("…and the same arrival on a stream that IS still watched does trigger it", async () => {
    // The control: without this, "triggers nothing" would also be satisfied by a fan-out that is simply broken.
    const reader: GithubVersionReader = {
      async listReleases() {
        return { rows: [ghRelease("v9.0.0")], complete: true };
      },
      async listTags() {
        return { rows: [], complete: true };
      },
      async commitDate() {
        return undefined;
      },
    };
    const { sync, submitted } = build([productAt("acme/copilot-api", true)], reader);
    const result = await sync.sync("acme", "prod-1", { subject: "dana" });
    expect(result.triggered).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      origin: { source: "product", productId: "prod-1", seriesKey: "quality", serviceVersion: "api@v9.0.0" },
    });
  });
});

describeTrust("TRUST-60/68 — a bounded read says so, and its side effects are all-or-none", () => {
  it("reports the service as errored instead of importing the newest page as if it were everything", async () => {
    // The shape this closes: the reader walked to a page ceiling and returned a bare array, so "5,000 rows
    // because that is all there are" and "5,000 rows because we stopped" were the same answer. That is the
    // one-page truncation the pagination replaced — scaled up, not removed. A bound nobody can observe reads
    // as completeness to whoever comes next, and this timeline is meant to be a system of record.
    const reader: GithubVersionReader = {
      async listReleases() {
        return { rows: [ghRelease("v9.0.0")], complete: false };
      },
      async listTags() {
        return { rows: [], complete: true };
      },
      async commitDate() {
        return undefined;
      },
    };
    // FIRST sync (no watermark, no ledger rows): nothing may be imported at all. The rows we did reach would
    // put the stream INTO the ledger, and the ledger is half the backfill discriminator — so the next sync
    // would stop calling this a backfill and every release beyond the ceiling would arrive as news.
    const first = build([productAt("acme/copilot-api", false)], reader);
    const backfilled = await first.sync.sync("acme", "prod-1", { subject: "dana" });
    expect(backfilled.services[0]?.error).toContain("read ceiling");
    expect(backfilled.services[0]?.error).toContain("cannot establish this service's baseline");
    expect(first.versions.rows).toHaveLength(0);

    // An already-synced stream HAS a baseline, so the news is on the pages we read. One policy all the way
    // through: the row lands, its fact goes out, and the auto-eval runs — with the incompleteness carried as
    // its own fact rather than as a throw. Committing the side effects and THEN throwing left the version in
    // the ledger, its fact delivered, and nothing evaluating it, permanently: the next sync sees the row as
    // already known, so the evaluation it skipped never happens at all.
    const { sync, versions, submitted } = build([productAt("acme/copilot-api", true)], reader);
    const result = await sync.sync("acme", "prod-1", { subject: "dana" });
    expect(result.services[0]?.incomplete).toBe(true);
    expect(result.services[0]?.error).toBeUndefined(); // coverage is not failure
    expect(versions.rows).toHaveLength(1);
    expect(result.triggered).toHaveLength(1); // ledger, fact and evaluation agree — all three, or none
    expect(submitted).toHaveLength(1);
  });
});
