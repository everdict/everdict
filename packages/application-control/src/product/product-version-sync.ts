import {
  NotFoundError,
  PRODUCT_VERSION_NOTES_LIMIT,
  type ProductRecord,
  type ProductSeries,
  type ProductService as ProductServiceEntry,
  type ProductServiceVersionRecord,
} from "@everdict/contracts";
import { Product, type SeriesContractResolution, sameSourceCoordinates, serviceStreamKey } from "@everdict/domain";
import type { GithubRepositoryTokenSource } from "../issue/github-issue-sync.js";
import { stampFacts } from "../platform-event/outbox.js";
import type { GithubVersionReaderFactory } from "../ports/github-repo-writer.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { ProductStore, ProductVersionStore, ReleaseStore } from "../ports/product-store.js";
import { findProductByRef } from "./product-ref.js";
import { SeriesEvaluator, type SeriesRunOutcome, type SeriesRunSubmitter } from "./series-evaluator.js";

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
  // Rows that were imported but are NOT news — publications at or below the remote head this service had
  // already observed, i.e. history a widened read ceiling revealed rather than releases that just happened
  // (arch-review 19 P1). They land in the ledger and trigger nothing.
  recovered?: number;
  // The read reached its page ceiling, so this service's OLDER history is not all here (arch-review 16 P1-4).
  // Distinct from `error`: the rows that did land are real and their downstream effects ran. It is a fact
  // about coverage, and a caller that needs a complete history must act on it.
  incomplete?: boolean;
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

export interface ProductVersionSyncDeps {
  products: ProductStore;
  releases: ReleaseStore;
  versions: ProductVersionStore;
  tokens: GithubRepositoryTokenSource;
  readers: GithubVersionReaderFactory;
  // Absent = imports land and announce themselves, but nothing runs (a deployment without the eval plane).
  submitSeriesRun?: SeriesRunSubmitter;
  // Resolve a series' CONCRETE contract at submit time (arch-review 13 P0) — the same seam ProductService
  // uses at readiness, so the stamp a batch carries and the contract a release compares it against are
  // produced by one function. Absent = batches ship unstamped, which readiness reads as evidence whose
  // question cannot be named.
  resolveSeriesContract?: (tenant: string, series: ProductSeries) => Promise<SeriesContractResolution>;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

// How many times the reconciler re-folds its watermark onto a concurrent edit before giving up. Bounded on
// purpose: a sweep that keeps losing has nothing urgent to save — the watermark is re-derivable next run, and
// the version ledger it guards is insert-once regardless.
const SYNC_COMMIT_ATTEMPTS = 3;

// A read that stopped at its page ceiling did NOT see the whole history, and saying so is the whole point
// (arch-review 15 §13): a bare array made "5,000 rows because that is all there are" and "5,000 rows because we
// stopped" the same answer, which is the one-page truncation the pagination replaced, only larger.
function ceilingMessage(repository: string, backfill: boolean): string {
  return `the version history of ${repository} exceeds the read ceiling — ${
    backfill
      ? "nothing was imported, because a first sync that reads only part of a history cannot establish this service's baseline: every release it failed to reach would arrive later as news"
      : "imported the newest page(s) only"
  }; raise maxPages or narrow the tagPrefix before treating this service's timeline as complete`;
}

export class ProductVersionSync {
  private readonly newId: () => string;
  private readonly now: () => string;
  // The fan-out itself is not the sync's — it is the one shared by every trigger that runs a series
  // (docs/architecture/product-timeline.md). Stateless, so composing it here from the seams this collaborator
  // already holds is the same object the on-demand path runs through.
  private readonly evaluator: SeriesEvaluator;

  constructor(private readonly deps: ProductVersionSyncDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.evaluator = new SeriesEvaluator({
      releases: deps.releases,
      ...(deps.submitSeriesRun !== undefined ? { submitSeriesRun: deps.submitSeriesRun } : {}),
      ...(deps.resolveSeriesContract !== undefined ? { resolveSeriesContract: deps.resolveSeriesContract } : {}),
    });
  }

  // Pull every tracked service's releases/tags into the ledger. Per-service soft-fail (the issue sync's
  // viewWithRepos stance): one repository the App cannot reach must not hide the others' versions — the error
  // is recorded on the service's sync state and reported in the outcome instead.
  async sync(tenant: string, ref: string, actor: { subject: string }): Promise<ProductSyncResult> {
    // Slug OR id, through the SAME resolver the service uses (mig 0169) — the screen shows the slug, so a
    // Sync that only understood ids would refuse the one address anybody has in hand.
    const initial = await findProductByRef(this.deps.products, tenant, ref);
    if (!initial) throw new NotFoundError("NOT_FOUND", { productId: ref }, `product '${ref}' not found.`);
    const productId = initial.id;
    // Fold the per-service sync-state transitions locally and write ONCE at the end — a patch per service
    // would be N read-modify-write races against ourselves.
    let record: ProductRecord = initial;
    const outcomes: ProductSyncServiceOutcome[] = [];
    const inserted: ProductServiceVersionRecord[] = [];
    for (const service of initial.services) {
      try {
        // BACKFILL means "this service has never been synced before", and it takes BOTH signals to answer
        // that safely (arch-review 13). The watermark alone was fragile: a first sync whose watermark write
        // lost its CAS three times left the service permanently in backfill — its rows were already in the
        // insert-once ledger, so the next sync found nothing new, and a genuinely new version arriving later
        // landed as backfill too. Silently, forever, because news is computed once per row.
        //
        // The ledger alone is wrong in the other direction: a service whose repository had no releases yet
        // synced successfully and imported nothing, so "no rows" would call its FIRST real release history.
        //
        // Either signal is evidence of a completed sync, so backfill requires the absence of both. Wrong in
        // the safe direction: the worst case is announcing a version that was arguably history, which is a
        // reader's judgement to make — versus silently swallowing a release, which nobody can recover.
        const backfill =
          service.sync?.syncedAt === undefined &&
          !(await this.hasImportedHistory(tenant, productId, service.name, serviceStreamKey(service)));
        const { rows, complete } = await this.importService(tenant, record, service, actor, backfill);
        // A backfilled row counts as imported (it is on the timeline now) but is never news — only
        // post-watermark arrivals reach the auto-eval below.
        //
        // …AND NEITHER IS A RECOVERED TAIL (arch-review 19 P1). A page-ceiling read imports the newest pages;
        // when an operator raises the ceiling, everything below it arrives as rows the ledger has never seen —
        // NEW to us, and OLD facts about the world. Firing an evaluation wave for releases that shipped years
        // ago writes a causal story that never happened and bills for it. The boundary is the release's own
        // publication instant against the newest one this service had already observed.
        const head = service.sync?.observedRemoteHead;
        const news = head === undefined ? rows : rows.filter((r) => r.publishedAt > head);
        if (!backfill) inserted.push(...news);
        outcomes.push({
          name: service.name,
          imported: rows.length,
          ...(complete ? {} : { incomplete: true }),
          ...(news.length !== rows.length ? { recovered: rows.length - news.length } : {}),
        });
        // …and the observation is DURABLE, not only in this response (arch-review 17 P1-6), including the
        // remote head this sync advanced to (19 P1).
        const newestSeen = rows.reduce<string | undefined>(
          (max, r) => (max === undefined || r.publishedAt > max ? r.publishedAt : max),
          head,
        );
        record = {
          ...record,
          ...Product.from(record).markServiceSynced(service.name, this.now(), complete, newestSeen).patch,
        };
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
    const watermarkSaved = await this.commitSyncState(tenant, productId, record);
    if (!watermarkSaved) {
      // Say it. The watermark is no longer load-bearing for the backfill boundary (the ledger is), so losing
      // it costs a re-listing rather than a lost event — but a reconciler that silently fails to persist its
      // cursor is a reconciler nobody can tell is degraded.
      outcomes.push({
        name: "*",
        imported: 0,
        error: "sync watermark could not be persisted (concurrent product edits)",
      });
    }
    // …and the auto-eval plans against the CURRENT product, not the one read before a network round trip
    // (arch-review 12 P1). Series definitions are editable, so submitting under the definition this sync
    // happened to open with produced batches stamped `seriesKey: quality` that were run under a dataset or
    // harness the product had since replaced — a new evaluation created from a standing policy that no
    // longer stands, landing on the trend as if it were the current one.
    const current = await this.deps.products.get(tenant, productId);
    // DELETED mid-sync is a lifecycle fact, not "we could not find the current config" (arch-review 13).
    // Falling back to the snapshot this sync opened with would submit evaluations for a product that no
    // longer exists, under a definition nobody can look up — scorecards stamped `productId` for a timeline
    // that was removed. The imports already landed and the ledger is insert-once, so stopping here loses
    // nothing that was not already lost by the delete.
    if (!current) return { services: outcomes, triggered: [] };
    // ONLY the CURRENT streams' arrivals trigger the current product's evaluation (arch-review 15 §12). A
    // repoint that lands mid-sync leaves this run holding rows imported from the stream the service USED to
    // point at; running the new definition because the old stream moved attributes a cause to an effect it
    // did not have. The evaluation would not be wrong — it evaluates the current series — but the timeline
    // would say "we ran this because repo-A released v5" about a product that no longer watches repo-A.
    const liveStreams = new Set(current.services.map((s) => serviceStreamKey(s)));
    const causedByCurrent = inserted.filter((row) => liveStreams.has(row.streamKey ?? ""));
    const { triggered, failedSeries } = await this.autoEval(tenant, current, causedByCurrent);
    return { services: outcomes, triggered, ...(failedSeries.length > 0 ? { failedSeries } : {}) };
  }

  // Has this service ever landed a row? The DURABLE half of the backfill discriminator — see `sync`. One row
  // is enough to answer it, so the read is bounded regardless of how much history a product carries.
  private async hasImportedHistory(
    tenant: string,
    productId: string,
    service: string,
    streamKey: string,
  ): Promise<boolean> {
    // Scoped to the STREAM (arch-review 14 P1). Asked by name, this saw repo-A's rows after a repoint and
    // declared repo-B's first sync "not a backfill" — so repo-B's entire back catalogue was announced as
    // news. A new stream has no history until it imports some.
    const rows = await this.deps.versions.list(tenant, { productId, service, streamKey, limit: 1 });
    return rows.length > 0;
  }

  // Persist THIS SYNC'S watermark under the product's optimistic guard, re-folding onto a concurrent edit
  // instead of overwriting it. Bounded: a sweep that keeps losing the race has nothing urgent to save — the
  // watermark is re-derivable from the next run, and the version ledger it protects is insert-once anyway.
  private async commitSyncState(tenant: string, productId: string, folded: ProductRecord): Promise<boolean> {
    // Keyed by NAME but validated on the STREAM (arch-review 13). Restoring by name alone let this
    // reconciler undo a decision the domain had just made: an edit that repoints "api" from repo-A to repo-B
    // clears the watermark precisely because it describes a stream the name no longer tracks — and then a
    // sync that had started before the edit put repo-A's watermark back on repo-B. The domain says
    // "coordinates decide"; this now executes the same function rather than re-interpreting it as
    // "same name ⇒ same stream".
    const foldedByName = new Map(folded.services.map((s) => [s.name, s] as const));
    for (let attempt = 0; attempt < SYNC_COMMIT_ATTEMPTS; attempt++) {
      const live = attempt === 0 ? folded : await this.deps.products.get(tenant, productId);
      if (!live) return true; // the product was deleted mid-sync — there is no watermark to keep
      // Only the sync state is carried forward. Whatever a member changed about names, series or repos is
      // the live record's, and this write must not have an opinion about it.
      const services = live.services.map((s) => {
        const mine = foldedByName.get(s.name);
        // Same name AND same stream, or this sync has nothing to say about it.
        if (mine === undefined || mine.sync === undefined || !sameSourceCoordinates(mine, s)) return s;
        return { ...s, sync: mine.sync };
      });
      const written = await this.deps.products.update(tenant, productId, { services }, undefined, {
        expectVersion: live.version ?? 0,
      });
      if (written !== undefined) return true;
    }
    return false;
  }

  private async importService(
    tenant: string,
    product: ProductRecord,
    service: ProductServiceEntry,
    actor: { subject: string },
    backfill: boolean,
    // `complete` says whether the remote read saw the whole history — see the return statement for why this
    // is a returned FACT rather than a throw (arch-review 16 P1-4).
  ): Promise<{ rows: ProductServiceVersionRecord[]; complete: boolean }> {
    const { token, host } = await this.deps.tokens.tokenForRepository(
      tenant,
      service.repository,
      { contents: "read" },
      service.host,
    );
    const reader = this.deps.readers.for(token, host);
    let incomplete = false;
    // KNOWN within this STREAM (arch-review 14 P1). Collected by name, repo-A's v1.0.0 made repo-B's v1.0.0
    // look already-imported and it never even reached the store — so the stream-scoped key the store had
    // just learned to honour was never given the chance to.
    const known = new Set(
      (
        await this.deps.versions.list(tenant, {
          productId: product.id,
          service: service.name,
          streamKey: serviceStreamKey(service),
        })
      ).map((row) => row.version),
    );
    const prefixed = (name: string): boolean => service.tagPrefix === undefined || name.startsWith(service.tagPrefix);
    const candidates: Array<Omit<ProductServiceVersionRecord, "id" | "tenant" | "productId" | "service">> = [];
    if (service.source === "releases") {
      const releases = await reader.listReleases(service.repository, { perPage: LIST_PER_PAGE });
      // A walk that stopped at the ceiling did NOT see the whole history, and a backfill that says otherwise
      // is the truncation this pagination replaced, only larger (arch-review 15 §13). Recorded on the
      // service's sync state so an operator can see which services are only partly imported.
      if (!releases.complete) incomplete = true;
      for (const release of releases.rows) {
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
      const tags = await reader.listTags(service.repository, { perPage: LIST_PER_PAGE });
      if (!tags.complete) incomplete = true;
      for (const tag of tags.rows) {
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
    // A BACKFILL CANNOT PROCEED ON A PARTIAL READ. Importing the pages we did reach puts rows in the ledger,
    // and the ledger is half the backfill discriminator — so the very next sync would stop calling this stream
    // a backfill, and every release beyond the ceiling would then arrive as NEWS: fan-outs and facts for
    // versions that shipped years ago. Refusing costs an operator one `maxPages` change; proceeding costs a
    // timeline that cannot be told apart from a real one.
    if (incomplete && backfill) throw new Error(ceilingMessage(service.repository, true));
    const insertedRows: ProductServiceVersionRecord[] = [];
    for (const candidate of candidates) {
      const row: ProductServiceVersionRecord = {
        id: this.newId(),
        tenant,
        productId: product.id,
        service: service.name,
        // WHICH STREAM produced it (mig 0155) — the ledger's insert-once identity. The domain owns what
        // "same stream" means; this stamps its answer rather than restating the coordinates.
        streamKey: serviceStreamKey(service),
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
    // ONE POLICY, ALL THE WAY THROUGH (arch-review 16 P1-4). This used to insert the rows, emit their facts,
    // and THEN throw — which is not fail-closed, because the caller treats a throw as "this service imported
    // nothing" and skips the auto-eval. The result was a permanent causal split: the version is in the ledger
    // and its `product.service_version_imported` fact went out, but nothing evaluated it and the outcome said
    // `imported: 0`. The next sync sees the row as already known, so the evaluation never happens at all.
    //
    // An error AFTER committing side effects is not fail-closed when downstream effects depend on the success
    // return. For an established stream the news IS on the pages we read — the ceiling only hides older
    // history — so the rows, their facts and their evaluation all proceed, and the incompleteness travels as
    // its own fact on the outcome. (The BACKFILL case is the opposite policy and stays that way: it has no
    // baseline, so it imports nothing at all.)
    return { rows: insertedRows, complete: !incomplete };
  }

  // The auto-eval choke point: one sync with N genuinely-new versions runs each watched series ONCE, stamped
  // with the newest version that arrived — the timeline's link from the scorecard point back to what changed.
  // Watched = the active planned release's selection when one exists (that is what "this release watches these
  // axes" means), else every product series.
  //
  // The fan-out itself belongs to SeriesEvaluator, which the declaration seed and the manual run share: what
  // is the SYNC's is only the trigger condition above it. A sync that imported nothing new has nothing to
  // announce, and that is the whole of what this method decides.
  private async autoEval(
    tenant: string,
    product: ProductRecord,
    inserted: readonly ProductServiceVersionRecord[],
  ): Promise<SeriesRunOutcome> {
    if (inserted.length === 0 || !product.autoEval.enabled) return { triggered: [], failedSeries: [] };
    const newest = [...inserted].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).at(-1);
    return this.evaluator.run(tenant, product, {
      // The schedule precedent: a machine-fired batch is submitted as the product's creator — the person who
      // declared the standing evaluation, not whoever happened to press Sync.
      submittedBy: product.createdBy,
      trigger: "version_import",
      ...(newest !== undefined ? { serviceVersion: `${newest.service}@${newest.version}` } : {}),
    });
  }
}
