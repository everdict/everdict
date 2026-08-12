import type {
  DomainFact,
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
  facts: DomainFact[];
}

export interface NewProductInput {
  id: string;
  tenant: string;
  // The address (mig 0169). Minted by the service, which is the only layer that can see whether it is free.
  slug?: string;
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

// WHICH VERSION STREAM a tracked service points at — the identity behind "same service", which is NOT the
// service's name (arch-review 13). A name is what people call it; the coordinates are what it reads.
//
// EXPORTED, and that is the point. This decision had two consumers reading it differently: the product edit
// applied it correctly (change the coordinates and the watermark cannot survive, because it describes a
// stream this name no longer tracks), while the sync reconciler re-matched services by NAME alone and could
// therefore restore repo-A's watermark onto a service now pointing at repo-B. And the version ledger keyed
// on the name too, so repo-A's v1.0.0 and repo-B's v1.0.0 collided as one row. One invariant with three
// implementations, two of them wrong. There is now one function, and everything that means "same stream"
// executes it.
export function serviceStreamKey(
  service: Pick<ProductService, "repository" | "source" | "host" | "tagPrefix">,
): string {
  // A CANONICAL TUPLE, not a delimiter-joined string. The first version joined on U+0000 "because no
  // coordinate can contain it" — true, and it made the value unstorable: this lands in a Postgres `text`
  // column, and Postgres rejects NUL outright (`invalid byte sequence for encoding "UTF8": 0x00`). Every
  // version import would have failed at the driver. A separator chosen for what it excludes is a separator
  // chosen without asking where the value goes.
  //
  // JSON.stringify of a fixed-arity array is unambiguous by construction — no separator to collide with, no
  // escaping rules to get wrong — and stays readable, which is what the original comment actually wanted: an
  // operator asking "why did this re-import" gets an answer they can read.
  return JSON.stringify([service.host ?? "", service.repository, service.source, service.tagPrefix ?? ""]);
}

// The slug a product's NAME wants (mig 0169) — the stem, before uniqueness is settled. Pure and total: it
// always returns something addressable, because the caller is minting an address and "no answer" is not one of
// the options a create can take.
//
// Unicode survives on purpose (`제품 타임라인` → `제품-타임라인`): stripping to ASCII would turn every product
// named in the workspace's own language into `product-1`, `product-2`, which is a worse address than the uuid
// this replaces. What is removed is everything that would change how a URL parses.
export function productSlugStem(name: string): string {
  const stem = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Ll}\p{Lo}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, ""); // the 64-char cut may land mid-separator
  // A name made entirely of characters a URL cannot carry (punctuation, emoji) leaves nothing to address by.
  // `product` then reads as what it is, and the service's collision loop makes it unique.
  return stem.length > 0 ? stem : "product";
}

export function sameSourceCoordinates(
  a: Pick<ProductService, "repository" | "source" | "host" | "tagPrefix">,
  b: Pick<ProductService, "repository" | "source" | "host" | "tagPrefix">,
): boolean {
  return serviceStreamKey(a) === serviceStreamKey(b);
}

// WHAT A SERIES ASKS, as a comparable value. `key` is the TREND's identity and deliberately survives every
// edit, which is exactly why it cannot answer "does the evidence under this key still answer the question":
// a series re-pointed at another dataset keeps its key and keeps its chart, while every point on it now
// answers something else.
//
// Judges are order-insensitive (the schema already refuses a repeated id), because reordering a selection
// asks nothing new. `label`, `requiredForRelease` and `allowNoBaseline` are excluded on purpose: the first is
// how the question is spelled and the other two are what we DO with its answer, none of them what is asked.
//
// Deliberately NOT the resolved contract digest. That one needs the registries and sees a floating `latest`
// move underneath an unchanged declaration, which is why the RELEASE GATE compares it; this is the pure half
// a WRITE can recognize with no I/O, and its job is narrower — deciding whether a declaration owes a run.
export function seriesQuestion(series: ProductSeries): string {
  return JSON.stringify([
    [series.dataset.id, series.dataset.version ?? ""],
    [series.harness.id, series.harness.version ?? ""],
    [...(series.judges ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map((judge) => [judge.id, judge.version ?? ""]),
  ]);
}

// The series a write leaves with NO evidence answering them — newly declared ones, and ones whose question
// changed under a stable key. One fact from the gate's point of view: a required series with no current
// answer BLOCKS a release ("not evaluated is never green", and a stale contract digest reads the same way), so
// both are what the declaration owes a first run. Keys, not rows, because the caller re-reads the series it
// persisted rather than the ones it was handed.
export function seriesNeedingEvidence(prior: readonly ProductSeries[], next: readonly ProductSeries[]): string[] {
  const asked = new Map(prior.map((series) => [series.key, seriesQuestion(series)]));
  return next.filter((series) => asked.get(series.key) !== seriesQuestion(series)).map((series) => series.key);
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
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
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

  static creationFacts(record: ProductRecord): DomainFact[] {
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
  // `complete` says whether the remote read saw the whole history (arch-review 17 P1-6). It is recorded on
  // the row, not only returned in the sync response: a sweep, a later reader or an owner-agent has no other
  // way to learn that this service's timeline is a prefix. The whole sync state is replaced, so a stream that
  // reads completely today clears a `partial` it carried yesterday — which is the point of recording an
  // OBSERVATION rather than a sticky flag.
  // `observedRemoteHead` only ever ADVANCES (arch-review 19 P1). It answers "what had we already seen", which
  // is what separates a genuinely new release from one a widened read ceiling merely revealed — and a
  // recovered tail is full of publications OLDER than the head, so letting it move backwards would turn the
  // whole back catalogue into news exactly once, which is precisely the wave it exists to prevent.
  markServiceSynced(name: string, syncedAt: string, complete = true, remoteHead?: string): ProductTransition {
    return {
      patch: {
        services: this.record.services.map((service) => {
          if (service.name !== name) return service;
          const previous = service.sync?.observedRemoteHead;
          const head =
            remoteHead !== undefined && (previous === undefined || remoteHead > previous) ? remoteHead : previous;
          return {
            ...service,
            sync: {
              syncedAt,
              ...(complete
                ? { completeness: "complete" as const }
                : { completeness: "partial" as const, partialAt: syncedAt }),
              ...(head !== undefined ? { observedRemoteHead: head } : {}),
            },
          };
        }),
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
  versionImportFact(version: ProductServiceVersionRecord, actor: string): DomainFact {
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
    };
  }
}
