import {
  NotFoundError,
  PRODUCT_VERSION_NOTES_LIMIT,
  type ProductRecord,
  type ProductSeries,
  type ProductService as ProductServiceEntry,
  type ProductServiceVersionRecord,
} from "@everdict/contracts";
import { Product, watchedSeries } from "@everdict/domain";
import type { GithubRepositoryTokenSource } from "../issue/github-issue-sync.js";
import { stampFacts } from "../platform-event/outbox.js";
import type { GithubVersionReaderFactory } from "../ports/github-repo-writer.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { ProductStore, ProductVersionStore, ReleaseStore } from "../ports/product-store.js";

// GitHub release/tag import for the product timeline (docs/architecture/product-timeline.md). Everdict stays
// the client — a pull happens when a member presses Sync (later: the sweep), never by webhook, the same stance
// the issue sync takes. The ledger write is the choke point: it is insert-once by natural key, the
// product.service_version_imported fact rides ONLY an actual insert, and the auto-eval fans out from exactly
// the set of rows that actually landed — so one version can trigger one wave of evaluation, ever.

const LIST_PER_PAGE = 100;

export interface ProductSyncServiceOutcome {
  name: string;
  imported: number;
  error?: string;
}

export interface ProductSyncResult {
  services: ProductSyncServiceOutcome[];
  // The scorecards the import fanned out (one per watched series) — empty on a backfill or when auto-eval is
  // off/unwired.
  triggered: string[];
  // Series whose submit failed. One broken series must not sink the sync (the imports already landed), but a
  // silently missing batch would read as "the product got worse" — so the failure is part of the outcome.
  failedSeries?: Array<{ key: string; error: string }>;
}

// The submit seam — what the auto-eval needs from the scorecard plane, as a function so this collaborator
// depends on behaviour (the composition root closes it over ScorecardService.submit). Versions are refs:
// absent = latest at run time, which is what a standing series means.
export type SeriesRunSubmitter = (input: {
  tenant: string;
  submittedBy: string;
  dataset: { id: string; version?: string };
  harness: { id: string; version?: string };
  judges: Array<{ id: string; version?: string }>;
  runtime?: string;
  origin: {
    source: "product";
    productId: string;
    releaseId?: string;
    seriesKey: string;
    serviceVersion?: string;
  };
}) => Promise<{ id: string }>;

export interface ProductVersionSyncDeps {
  products: ProductStore;
  releases: ReleaseStore;
  versions: ProductVersionStore;
  tokens: GithubRepositoryTokenSource;
  readers: GithubVersionReaderFactory;
  // Absent = imports land and announce themselves, but nothing runs (a deployment without the eval plane).
  submitSeriesRun?: SeriesRunSubmitter;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

// How many times the reconciler re-folds its watermark onto a concurrent edit before giving up. Bounded on
// purpose: a sweep that keeps losing has nothing urgent to save — the watermark is re-derivable next run, and
// the version ledger it guards is insert-once regardless.
const SYNC_COMMIT_ATTEMPTS = 3;

export class ProductVersionSync {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: ProductVersionSyncDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // Pull every tracked service's releases/tags into the ledger. Per-service soft-fail (the issue sync's
  // viewWithRepos stance): one repository the App cannot reach must not hide the others' versions — the error
  // is recorded on the service's sync state and reported in the outcome instead.
  async sync(tenant: string, productId: string, actor: { subject: string }): Promise<ProductSyncResult> {
    const initial = await this.deps.products.get(tenant, productId);
    if (!initial) throw new NotFoundError("NOT_FOUND", { productId }, `product '${productId}' not found.`);
    // Fold the per-service sync-state transitions locally and write ONCE at the end — a patch per service
    // would be N read-modify-write races against ourselves.
    let record: ProductRecord = initial;
    const outcomes: ProductSyncServiceOutcome[] = [];
    const inserted: ProductServiceVersionRecord[] = [];
    for (const service of initial.services) {
      try {
        const backfill = service.sync?.syncedAt === undefined;
        const rows = await this.importService(tenant, record, service, actor, backfill);
        // A backfilled row counts as imported (it is on the timeline now) but is never news — only
        // post-watermark arrivals reach the auto-eval below.
        if (!backfill) inserted.push(...rows);
        outcomes.push({ name: service.name, imported: rows.length });
        record = { ...record, ...Product.from(record).markServiceSynced(service.name, this.now()).patch };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outcomes.push({ name: service.name, imported: 0, error: message });
        record = {
          ...record,
          ...Product.from(record).markServiceSyncError(service.name, this.now(), message).patch,
        };
      }
    }
    // The sync joins the PRODUCT'S CAS CONSTITUTION (arch-review 12 P1). This write used to carry no guard,
    // so a sweep that read `services` at the top and wrote them back minutes later could revert a member's
    // edit made in between — silently, because the sync's own `version + 1` proved a write had happened. An
    // invariant that lives as an optional guard on a port is an invariant every caller may forget, and this
    // caller had.
    //
    // A miss is not an error here: this is a RECONCILER, and the right answer to "someone else wrote" is to
    // re-read and re-apply only what this sync owns — the per-service watermark — rather than to fail a sweep
    // or to insist on the world it saw first.
    await this.commitSyncState(tenant, productId, record);
    // …and the auto-eval plans against the CURRENT product, not the one read before a network round trip
    // (arch-review 12 P1). Series definitions are editable, so submitting under the definition this sync
    // happened to open with produced batches stamped `seriesKey: quality` that were run under a dataset or
    // harness the product had since replaced — a new evaluation created from a standing policy that no
    // longer stands, landing on the trend as if it were the current one.
    const current = (await this.deps.products.get(tenant, productId)) ?? record;
    const { triggered, failedSeries } = await this.autoEval(tenant, current, inserted);
    return { services: outcomes, triggered, ...(failedSeries.length > 0 ? { failedSeries } : {}) };
  }

  // Persist THIS SYNC'S watermark under the product's optimistic guard, re-folding onto a concurrent edit
  // instead of overwriting it. Bounded: a sweep that keeps losing the race has nothing urgent to save — the
  // watermark is re-derivable from the next run, and the version ledger it protects is insert-once anyway.
  private async commitSyncState(tenant: string, productId: string, folded: ProductRecord): Promise<void> {
    const syncByName = new Map(folded.services.map((s) => [s.name, s.sync] as const));
    for (let attempt = 0; attempt < SYNC_COMMIT_ATTEMPTS; attempt++) {
      const live = attempt === 0 ? folded : await this.deps.products.get(tenant, productId);
      if (!live) return; // the product was deleted mid-sync — there is no watermark to keep
      // Only the sync state is carried forward. Whatever a member changed about names, series or repos is
      // the live record's, and this write must not have an opinion about it.
      const services = live.services.map((s) => {
        const sync = syncByName.get(s.name);
        return sync === undefined ? s : { ...s, sync };
      });
      const written = await this.deps.products.update(tenant, productId, { services }, undefined, {
        expectVersion: live.version ?? 0,
      });
      if (written !== undefined) return;
    }
  }

  private async importService(
    tenant: string,
    product: ProductRecord,
    service: ProductServiceEntry,
    actor: { subject: string },
    backfill: boolean,
  ): Promise<ProductServiceVersionRecord[]> {
    const { token, host } = await this.deps.tokens.tokenForRepository(
      tenant,
      service.repository,
      { contents: "read" },
      service.host,
    );
    const reader = this.deps.readers.for(token, host);
    const known = new Set(
      (await this.deps.versions.list(tenant, { productId: product.id, service: service.name })).map(
        (row) => row.version,
      ),
    );
    const prefixed = (name: string): boolean => service.tagPrefix === undefined || name.startsWith(service.tagPrefix);
    const candidates: Array<Omit<ProductServiceVersionRecord, "id" | "tenant" | "productId" | "service">> = [];
    if (service.source === "releases") {
      for (const release of await reader.listReleases(service.repository, { perPage: LIST_PER_PAGE })) {
        // A draft has not made the "released" claim yet; publishedAt is the remote's own instant.
        if (release.draft || release.publishedAt === undefined || !prefixed(release.tagName)) continue;
        if (known.has(release.tagName)) continue;
        candidates.push({
          version: release.tagName,
          kind: "release",
          prerelease: release.prerelease,
          url: release.url,
          ...(release.body !== undefined && release.body.length > 0
            ? { notes: release.body.slice(0, PRODUCT_VERSION_NOTES_LIMIT) }
            : {}),
          publishedAt: release.publishedAt,
          importedAt: this.now(),
        });
      }
    } else {
      for (const tag of await reader.listTags(service.repository, { perPage: LIST_PER_PAGE })) {
        if (!prefixed(tag.name) || known.has(tag.name)) continue;
        // Tags carry no date; the commit's is the closest fact — fetched only for genuinely new tags, so a
        // steady-state sync costs one or two commit reads, not one per tag ever published.
        const date = await reader.commitDate(service.repository, tag.sha);
        candidates.push({
          version: tag.name,
          kind: "tag",
          prerelease: false,
          sha: tag.sha,
          publishedAt: date ?? this.now(),
          importedAt: this.now(),
        });
      }
    }
    const insertedRows: ProductServiceVersionRecord[] = [];
    for (const candidate of candidates) {
      const row: ProductServiceVersionRecord = {
        id: this.newId(),
        tenant,
        productId: product.id,
        service: service.name,
        ...candidate,
      };
      // A backfill fills the timeline's past without emitting: fifty historical releases arriving at once are
      // not fifty pieces of news, and nothing downstream (feed, subscriptions, auto-eval) should fire for them.
      const stamped = backfill
        ? []
        : stampFacts(tenant, [Product.from(product).versionImportFact(row, actor.subject)], {
            newId: this.newId,
            now: this.now,
          });
      const created = await this.deps.versions.create(
        row,
        stamped.map((s) => s.record),
      );
      if (!created) continue; // a racing sweep won — its facts already rode the insert
      if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
      insertedRows.push(row);
    }
    return insertedRows;
  }

  // The auto-eval choke point: one sync with N genuinely-new versions runs each watched series ONCE, stamped
  // with the newest version that arrived — the timeline's link from the scorecard point back to what changed.
  // Watched = the active planned release's selection when one exists (that is what "this release watches these
  // axes" means), else every product series.
  private async autoEval(
    tenant: string,
    product: ProductRecord,
    inserted: readonly ProductServiceVersionRecord[],
  ): Promise<{ triggered: string[]; failedSeries: Array<{ key: string; error: string }> }> {
    if (inserted.length === 0 || !product.autoEval.enabled || this.deps.submitSeriesRun === undefined)
      return { triggered: [], failedSeries: [] };
    const planned = (await this.deps.releases.list(tenant, { productId: product.id, status: "planned" }))[0];
    const series: readonly ProductSeries[] = watchedSeries(product, planned);
    if (series.length === 0) return { triggered: [], failedSeries: [] };
    const newest = [...inserted].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).at(-1);
    const serviceVersion = newest !== undefined ? `${newest.service}@${newest.version}` : undefined;
    const triggered: string[] = [];
    const failedSeries: Array<{ key: string; error: string }> = [];
    for (const entry of series) {
      try {
        const submitted = await this.deps.submitSeriesRun({
          tenant,
          // The schedule precedent: a machine-fired batch is submitted as the product's creator — the person
          // who declared the standing evaluation, not whoever happened to press Sync.
          submittedBy: product.createdBy,
          dataset: entry.dataset,
          harness: entry.harness,
          judges: entry.judges,
          ...(product.autoEval.runtime !== undefined ? { runtime: product.autoEval.runtime } : {}),
          origin: {
            source: "product",
            productId: product.id,
            ...(planned !== undefined ? { releaseId: planned.id } : {}),
            seriesKey: entry.key,
            ...(serviceVersion !== undefined ? { serviceVersion } : {}),
          },
        });
        triggered.push(submitted.id);
      } catch (err) {
        // One series' failed submit must not sink the others — the imports already landed; the missing batch
        // rides the outcome so it never reads as "the product got worse".
        failedSeries.push({ key: entry.key, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { triggered, failedSeries };
  }
}
