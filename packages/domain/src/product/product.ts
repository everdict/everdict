import type {
  PlatformFact,
  ProductAutoEval,
  ProductRecord,
  ProductSeries,
  ProductService,
  ProductServiceVersionRecord,
} from "@everdict/contracts";
import { BadRequestError, PRODUCT_SERIES_LIMIT } from "@everdict/contracts";
import { appendHistory } from "../tracker/history.js";

// The Product aggregate — the released thing several services compose (docs/architecture/product-timeline.md).
// Same {patch, facts} transition contract as the tracker: facts are born where legality is decided, the store
// persists both in one transaction, and transitions must never be spread — always use .patch.
export interface ProductTransition {
  patch: Partial<ProductRecord>;
  facts: PlatformFact[];
}

export interface NewProductInput {
  id: string;
  tenant: string;
  name: string;
  description?: string;
  icon?: string;
  services?: ProductService[];
  series?: ProductSeries[];
  autoEval?: ProductAutoEval;
  createdBy: string;
  now: string;
}

export interface ProductEditInput {
  name?: string;
  description?: string | null;
  icon?: string | null;
  // A list REPLACES what is there (the tracker's member-list rule): the editor sends the resulting set,
  // because a merging patch would make removal unexpressible.
  services?: ProductService[];
  series?: ProductSeries[];
  autoEval?: ProductAutoEval;
}

function assertUniqueServiceNames(services: readonly ProductService[], productId: string): void {
  const seen = new Set<string>();
  for (const service of services) {
    if (seen.has(service.name))
      throw new BadRequestError(
        "BAD_REQUEST",
        { product: productId, service: service.name },
        `Two services are both named "${service.name}" — the name is the timeline's key, so it must be unique.`,
      );
    seen.add(service.name);
  }
}

function assertSeries(series: readonly ProductSeries[], productId: string): void {
  if (series.length > PRODUCT_SERIES_LIMIT)
    throw new BadRequestError(
      "BAD_REQUEST",
      { product: productId, series: series.length },
      `A product watches at most ${PRODUCT_SERIES_LIMIT} series — one version import fans out into one batch per series.`,
    );
  const seen = new Set<string>();
  for (const entry of series) {
    if (seen.has(entry.key))
      throw new BadRequestError(
        "BAD_REQUEST",
        { product: productId, series: entry.key },
        `Two series share the key "${entry.key}" — the key is the trend's identity, so it must be unique.`,
      );
    seen.add(entry.key);
  }
}

// The source coordinates of a tracked service — when any of these change, the name now points at a different
// stream of versions, so the sync watermark must NOT survive (the next sync is a fresh backfill).
function sameSourceCoordinates(a: ProductService, b: ProductService): boolean {
  return a.repository === b.repository && a.source === b.source && a.host === b.host && a.tagPrefix === b.tagPrefix;
}

export class Product {
  private constructor(private readonly record: ProductRecord) {}

  static from(record: ProductRecord): Product {
    return new Product(record);
  }

  static newProduct(input: NewProductInput): ProductRecord {
    const services = input.services ?? [];
    const series = input.series ?? [];
    assertUniqueServiceNames(services, input.id);
    assertSeries(series, input.id);
    return {
      id: input.id,
      tenant: input.tenant,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      services,
      series,
      autoEval: input.autoEval ?? { enabled: true },
      history: [
        {
          at: input.now,
          by: input.createdBy,
          event: "created",
          detail: { services: services.length, series: series.length },
        },
      ],
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: ProductRecord): PlatformFact[] {
    return [
      {
        kind: "product.created",
        subject: { type: "product", id: record.id },
        actor: record.createdBy,
        payload: {
          name: record.name,
          services: record.services.length,
          series: record.series.length,
        },
        message: `Product created — ${record.name}`,
      },
    ];
  }

  get services(): readonly ProductService[] {
    return this.record.services;
  }

  get series(): readonly ProductSeries[] {
    return this.record.series;
  }

  update(fields: ProductEditInput, by: string, now: string): ProductTransition {
    const changed: string[] = [];
    const patch: Partial<ProductRecord> = {};
    if (fields.name !== undefined && fields.name !== this.record.name) {
      patch.name = fields.name;
      changed.push("name");
    }
    if (fields.description !== undefined) {
      const next = fields.description === null ? undefined : fields.description;
      if (next !== this.record.description) {
        patch.description = next;
        changed.push("description");
      }
    }
    if (fields.icon !== undefined) {
      const next = fields.icon === null ? undefined : fields.icon;
      if (next !== this.record.icon) {
        patch.icon = next;
        changed.push("icon");
      }
    }
    if (fields.services !== undefined) {
      assertUniqueServiceNames(fields.services, this.record.id);
      // The editor never sends sync state, so a re-declared service keeps its watermark — unless its source
      // coordinates changed, in which case the old watermark describes a stream this name no longer tracks.
      const next = fields.services.map((service) => {
        const prior = this.record.services.find((existing) => existing.name === service.name);
        return prior !== undefined && sameSourceCoordinates(prior, service) && prior.sync !== undefined
          ? { ...service, sync: prior.sync }
          : service;
      });
      if (JSON.stringify(next) !== JSON.stringify(this.record.services)) {
        patch.services = next;
        changed.push("services");
      }
    }
    if (fields.series !== undefined) {
      assertSeries(fields.series, this.record.id);
      if (JSON.stringify(fields.series) !== JSON.stringify(this.record.series)) {
        patch.series = fields.series;
        changed.push("series");
      }
    }
    if (fields.autoEval !== undefined) {
      if (
        fields.autoEval.enabled !== this.record.autoEval.enabled ||
        fields.autoEval.runtime !== this.record.autoEval.runtime
      ) {
        patch.autoEval = fields.autoEval;
        changed.push("autoEval");
      }
    }
    if (changed.length === 0)
      throw new BadRequestError("BAD_REQUEST", { product: this.record.id }, "Nothing to update.");
    patch.history = appendHistory(this.record.history, { at: now, by, event: "updated", detail: { changed } });
    patch.updatedAt = now;
    // Content editing — no facts (the tracker's rule): reshaping what a product watches is not lifecycle news;
    // the history entry is the audit trail.
    return { patch, facts: [] };
  }

  // The sync's bookkeeping write. Deliberately NOT a history entry and NOT an updatedAt bump: a sweep touching
  // the watermark every few minutes must not read as somebody editing the product.
  markServiceSynced(name: string, syncedAt: string): ProductTransition {
    return {
      patch: {
        services: this.record.services.map((service) =>
          service.name === name ? { ...service, sync: { syncedAt } } : service,
        ),
      },
      facts: [],
    };
  }

  markServiceSyncError(name: string, at: string, message: string): ProductTransition {
    return {
      patch: {
        services: this.record.services.map((service) =>
          service.name === name
            ? { ...service, sync: { ...(service.sync ?? {}), lastError: { at, message } } }
            : service,
        ),
      },
      facts: [],
    };
  }

  // The fact for one imported version — born here so the payload shape has exactly one author. The emit point
  // is the ledger write (idempotent by natural key), so one version can only ever be news once; the payload
  // keeps service/version/repository top-level so a subscription can filter per service.
  versionImportFact(version: ProductServiceVersionRecord, actor: string): PlatformFact {
    const service = this.record.services.find((entry) => entry.name === version.service);
    return {
      kind: "product.service_version_imported",
      subject: { type: "product", id: this.record.id },
      actor,
      payload: {
        service: version.service,
        version: version.version,
        ...(service !== undefined ? { repository: service.repository } : {}),
        kind: version.kind,
        prerelease: version.prerelease,
        publishedAt: version.publishedAt,
        name: this.record.name,
      },
      message: `${version.service} ${version.version} — ${this.record.name}`,
    };
  }
}
