import {
  BadRequestError,
  ForbiddenError,
  ISSUE_STATUSES,
  ISSUE_STATUS_CATEGORY,
  type IssueRecord,
  NotFoundError,
  type ProductAutoEval,
  type ProductRecord,
  type ProductSeries,
  type ProductService as ProductServiceEntry,
  type ProductServiceVersionRecord,
  type ReleaseReadiness,
  type ReleaseRecord,
  type ReleaseStatus,
  type ScorecardRecord,
} from "@everdict/contracts";
import type {
  ProductDetailResponse,
  ProductTimelineIssue,
  ProductTimelineResponse,
  ProductTimelineSeries,
  ReleaseDetailResponse,
} from "@everdict/contracts/wire";
import {
  Product,
  type ProductEditInput,
  type ProductTransition,
  Release,
  type ReleaseEditInput,
  type ReleaseTransition,
  type SeriesScorecardPoint,
  headlinePassRate,
  releaseReadiness,
  watchedSeries,
} from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { ProductStore, ProductVersionStore, ReleaseStore } from "../ports/product-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";

// The product timeline's facade (docs/architecture/product-timeline.md): products + releases + the derived
// readiness. Stores are injected directly (never peer services) so the release gate's read is one fan-out.
// The GitHub sync + the auto-eval fan-out live in the ProductVersionSync collaborator, composed beside this.

// "Open" has ONE definition in this codebase (records/tracker.ts) — the same derivation the tracker services use.
const OPEN_ISSUE_STATUSES = ISSUE_STATUSES.filter(
  (status) => ISSUE_STATUS_CATEGORY[status] !== "completed" && ISSUE_STATUS_CATEGORY[status] !== "canceled",
);

// How much of the version ledger a detail read serves — the timeline's visible past, not an export.
const DETAIL_VERSION_LIMIT = 100;

// The timeline's default window when the caller names none — a quarter, the span a release conversation looks at.
const TIMELINE_DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface ProductActor {
  subject: string;
  isAdmin?: boolean;
}

export interface CreateProductInput {
  tenant: string;
  createdBy: string;
  name: string;
  description?: string;
  icon?: string;
  services?: ProductServiceEntry[];
  series?: ProductSeries[];
  autoEval?: ProductAutoEval;
}

export interface CreateReleaseInput {
  tenant: string;
  createdBy: string;
  productId: string;
  name: string;
  description?: string;
  targetDate?: string;
  seriesKeys?: string[];
}

// What the series-ref validation needs from the registries — narrow functions, not the registry classes, so
// this service depends on behaviour (the subscription service's assertAgentTargets precedent). A ref is checked
// at WRITE time because a dangling id here would not fail loudly: it would silently produce a series whose
// every auto-run fails, which reads as "the product got worse" instead of "the declaration is broken".
export interface ProductCapabilityCheck {
  hasDataset(tenant: string, id: string): Promise<boolean>;
  hasHarness(tenant: string, id: string): Promise<boolean>;
  hasJudge(tenant: string, id: string): Promise<boolean>;
}

export interface ProductServiceDeps {
  store: ProductStore;
  releases: ReleaseStore;
  versions: ProductVersionStore;
  // The release gate's open-issue count (issues linked to the release). Absent = this deployment carries no
  // tracker, and the gate decides on the series alone.
  issues?: IssueStore;
  // The series trend/readiness points. Absent = no trend: every series reads "not run yet", never "regressed".
  scorecards?: ScorecardStore;
  capabilities?: ProductCapabilityCheck;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

export class ProductService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: ProductServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateProductInput): Promise<ProductRecord> {
    await this.assertSeriesRefs(input.tenant, input.series ?? []);
    const record = Product.newProduct({
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.services !== undefined ? { services: input.services } : {}),
      ...(input.series !== undefined ? { series: input.series } : {}),
      ...(input.autoEval !== undefined ? { autoEval: input.autoEval } : {}),
      createdBy: input.createdBy,
      now: this.now(),
    });
    const stamped = stampFacts(record.tenant, Product.creationFacts(record), { newId: this.newId, now: this.now });
    await this.deps.store.create(
      record,
      stamped.map((s) => s.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return record;
  }

  async list(tenant: string): Promise<ProductRecord[]> {
    return this.deps.store.list(tenant);
  }

  async get(tenant: string, id: string): Promise<ProductRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `product '${id}' not found.`);
    return record;
  }

  // The record plus what its screen opens on: the releases (every one — a product has a handful) and the
  // visible slice of the version ledger. The trend itself is the timeline read's job (heavier, windowed).
  async detail(tenant: string, id: string): Promise<ProductDetailResponse> {
    const record = await this.get(tenant, id);
    const [releases, versions] = await Promise.all([
      this.deps.releases.list(tenant, { productId: id }),
      this.deps.versions.list(tenant, { productId: id, limit: DETAIL_VERSION_LIMIT }),
    ]);
    return { ...record, releases, versions };
  }

  async update(tenant: string, id: string, fields: ProductEditInput, actor: ProductActor): Promise<ProductRecord> {
    const record = await this.get(tenant, id);
    if (fields.series !== undefined) await this.assertSeriesRefs(tenant, fields.series);
    return this.applyTransition(record, Product.from(record).update(fields, actor.subject, this.now()));
  }

  async remove(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const record = await this.get(tenant, id);
    if (record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "products:delete" },
        "You are not allowed to delete this product (creator or workspace admin only).",
      );
    // Releases and the version ledger exist only under their product (unlike the tracker's shared entities),
    // so deletion cascades rather than refusing — there is nowhere else they could sensibly go.
    const releases = await this.deps.releases.list(tenant, { productId: id });
    for (const release of releases) await this.deps.releases.remove(tenant, release.id);
    await this.deps.versions.removeForProduct(tenant, id);
    await this.deps.store.remove(tenant, id);
  }

  async listVersions(
    tenant: string,
    productId: string,
    filter?: { service?: string; limit?: number },
  ): Promise<ProductServiceVersionRecord[]> {
    await this.get(tenant, productId); // 404 for another workspace's product before serving its ledger
    return this.deps.versions.list(tenant, {
      productId,
      ...(filter?.service !== undefined ? { service: filter.service } : {}),
      ...(filter?.limit !== undefined ? { limit: filter.limit } : {}),
    });
  }

  // The product's time axis in ONE read (the pulse's treatment: composed from stores, drawn by the web):
  // releases (all — a handful, and a planned date may sit beyond any window), the windowed version ledger,
  // each watch series' scorecard points oldest-first, and the lifecycle markers of linked issues.
  async timeline(
    tenant: string,
    id: string,
    window?: { from?: string; to?: string },
  ): Promise<ProductTimelineResponse> {
    const product = await this.get(tenant, id);
    const to = window?.to ?? this.now();
    const from = window?.from ?? new Date(Date.parse(to) - TIMELINE_DEFAULT_WINDOW_MS).toISOString();
    const releases = await this.deps.releases.list(tenant, { productId: id });
    const versions = (await this.deps.versions.list(tenant, { productId: id })).filter(
      (row) => row.publishedAt >= from && row.publishedAt <= to,
    );
    const series: ProductTimelineSeries[] = [];
    for (const entry of product.series) {
      const rows =
        this.deps.scorecards === undefined
          ? []
          : await this.deps.scorecards.list(tenant, { productId: id, seriesKey: entry.key });
      series.push({
        key: entry.key,
        label: entry.label,
        points: rows
          .filter((row) => row.createdAt >= from && row.createdAt <= to)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((row) => {
            const rate = headlinePassRate(row);
            return {
              scorecardId: row.id,
              status: row.status,
              ...(rate !== null ? { passRate: rate } : {}),
              createdAt: row.createdAt,
              ...(row.origin?.serviceVersion !== undefined ? { serviceVersion: row.origin.serviceVersion } : {}),
              ...(row.origin?.releaseId !== undefined ? { releaseId: row.origin.releaseId } : {}),
            };
          }),
      });
    }
    const issues: ProductTimelineIssue[] = [];
    if (this.deps.issues !== undefined) {
      const seen = new Set<string>();
      const collect = (rows: readonly IssueRecord[], releaseId?: string): void => {
        for (const issue of rows) {
          if (seen.has(issue.id)) continue;
          seen.add(issue.id);
          issues.push({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            status: issue.status,
            createdAt: issue.createdAt,
            ...(issue.resolution?.at !== undefined ? { resolvedAt: issue.resolution.at } : {}),
            ...(releaseId !== undefined ? { releaseId } : {}),
          });
        }
      };
      collect(await this.deps.issues.list(tenant, { link: { type: "product", id } }));
      for (const release of releases)
        collect(await this.deps.issues.list(tenant, { link: { type: "release", id: release.id } }), release.id);
    }
    return { window: { from, to }, releases, versions, series, issues };
  }

  // --- Releases -----------------------------------------------------------------------------------------------

  async createRelease(input: CreateReleaseInput): Promise<ReleaseRecord> {
    const product = await this.get(input.tenant, input.productId);
    const record = Release.newRelease({
      id: this.newId(),
      tenant: input.tenant,
      productId: input.productId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      ...(input.seriesKeys !== undefined ? { seriesKeys: input.seriesKeys } : {}),
      productSeriesKeys: product.series.map((series) => series.key),
      createdBy: input.createdBy,
      now: this.now(),
    });
    const stamped = stampFacts(record.tenant, Release.creationFacts(record), { newId: this.newId, now: this.now });
    await this.deps.releases.create(
      record,
      stamped.map((s) => s.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return record;
  }

  // The workspace's releases, optionally one product's. A product filter is 404-scoped first so another
  // workspace's product id cannot be probed through its releases.
  async listReleases(tenant: string, productId?: string): Promise<ReleaseRecord[]> {
    if (productId !== undefined) await this.get(tenant, productId);
    return this.deps.releases.list(tenant, productId !== undefined ? { productId } : undefined);
  }

  async getRelease(tenant: string, id: string): Promise<ReleaseRecord> {
    const record = await this.deps.releases.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `release '${id}' not found.`);
    return record;
  }

  async releaseDetail(tenant: string, id: string): Promise<ReleaseDetailResponse> {
    const record = await this.getRelease(tenant, id);
    return { ...record, readiness: await this.readiness(tenant, record) };
  }

  async updateRelease(
    tenant: string,
    id: string,
    fields: ReleaseEditInput,
    actor: ProductActor,
  ): Promise<ReleaseRecord> {
    const record = await this.getRelease(tenant, id);
    const product = await this.get(tenant, record.productId);
    return this.applyReleaseTransition(
      record,
      Release.from(record).update(
        fields,
        actor.subject,
        this.now(),
        product.series.map((series) => series.key),
      ),
    );
  }

  // The release gate. The service counts (it owns the stores); the domain decides what the counts mean.
  async setReleaseStatus(
    tenant: string,
    id: string,
    input: { status: ReleaseStatus; force?: boolean },
    actor: ProductActor,
  ): Promise<ReleaseRecord> {
    const record = await this.getRelease(tenant, id);
    const readiness = await this.readiness(tenant, record);
    const transition = Release.from(record).setStatus(
      {
        to: input.status,
        openIssues: readiness.openIssues,
        regressedSeries: readiness.regressedSeries,
        ...(input.force !== undefined ? { force: input.force } : {}),
      },
      actor.subject,
      this.now(),
    );
    return this.applyReleaseTransition(record, transition);
  }

  async removeRelease(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const record = await this.getRelease(tenant, id);
    if (record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "releases:delete" },
        "You are not allowed to delete this release (creator or workspace admin only).",
      );
    await this.deps.releases.remove(tenant, id);
  }

  // How ready the release is: open linked issues + every watched series' latest point against its baseline.
  // The baseline is anchored at the PREVIOUS released release — "did we get worse since we last shipped" is
  // the question a release conversation asks; a series with no anchor yet reads as not regressed.
  async readiness(tenant: string, release: ReleaseRecord): Promise<ReleaseReadiness> {
    const product = await this.get(tenant, release.productId);
    const openIssues =
      this.deps.issues === undefined
        ? 0
        : (
            await this.deps.issues.list(tenant, {
              link: { type: "release", id: release.id },
              statuses: OPEN_ISSUE_STATUSES,
            })
          ).length;
    const anchor = await this.baselineAnchor(tenant, release);
    const latestBySeries = new Map<string, SeriesScorecardPoint>();
    const baselineBySeries = new Map<string, SeriesScorecardPoint>();
    if (this.deps.scorecards !== undefined) {
      for (const series of watchedSeries(product, release)) {
        const rows = (
          await this.deps.scorecards.list(tenant, {
            productId: product.id,
            seriesKey: series.key,
            status: "succeeded",
          })
        )
          // Newest first, explicitly — the port does not promise an order (Pg sorts, in-memory does not), and
          // "latest" deciding a release gate must not depend on which store happened to be wired.
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const latest = rows[0];
        if (latest !== undefined) latestBySeries.set(series.key, seriesPoint(latest));
        if (anchor !== undefined) {
          const baseline = rows.find((row) => row.createdAt <= anchor);
          if (baseline !== undefined) baselineBySeries.set(series.key, seriesPoint(baseline));
        }
      }
    }
    return releaseReadiness(release, product, latestBySeries, baselineBySeries, openIssues);
  }

  // The instant the product last shipped BEFORE this release — the baseline's anchor. For a released release
  // that is the ship before its own; for a planned one, the newest ship so far. `<=` because the release
  // itself is already excluded by id — a previous ship landing on this exact instant must still anchor.
  private async baselineAnchor(tenant: string, release: ReleaseRecord): Promise<string | undefined> {
    const released = await this.deps.releases.list(tenant, { productId: release.productId, status: "released" });
    const ceiling = release.releasedAt ?? this.now();
    return released
      .filter((row) => row.id !== release.id && row.releasedAt !== undefined && row.releasedAt <= ceiling)
      .map((row) => row.releasedAt as string)
      .sort()
      .at(-1);
  }

  private async assertSeriesRefs(tenant: string, series: readonly ProductSeries[]): Promise<void> {
    if (this.deps.capabilities === undefined) return;
    for (const entry of series) {
      if (!(await this.deps.capabilities.hasDataset(tenant, entry.dataset.id)))
        throw new BadRequestError(
          "BAD_REQUEST",
          { series: entry.key, dataset: entry.dataset.id },
          `Series "${entry.key}" names a dataset this workspace does not have: ${entry.dataset.id}.`,
        );
      if (!(await this.deps.capabilities.hasHarness(tenant, entry.harness.id)))
        throw new BadRequestError(
          "BAD_REQUEST",
          { series: entry.key, harness: entry.harness.id },
          `Series "${entry.key}" names a harness this workspace does not have: ${entry.harness.id}.`,
        );
      for (const judge of entry.judges) {
        if (!(await this.deps.capabilities.hasJudge(tenant, judge.id)))
          throw new BadRequestError(
            "BAD_REQUEST",
            { series: entry.key, judge: judge.id },
            `Series "${entry.key}" names a judge this workspace does not have: ${judge.id}.`,
          );
      }
    }
  }

  private async applyTransition(current: ProductRecord, transition: ProductTransition): Promise<ProductRecord> {
    const stamped = stampFacts(current.tenant, transition.facts, { newId: this.newId, now: this.now });
    const updated = await this.deps.store.update(
      current.tenant,
      current.id,
      transition.patch,
      stamped.map((s) => s.record),
    );
    if (!updated) throw new NotFoundError("NOT_FOUND", { id: current.id }, `product '${current.id}' not found.`);
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return updated;
  }

  private async applyReleaseTransition(current: ReleaseRecord, transition: ReleaseTransition): Promise<ReleaseRecord> {
    const stamped = stampFacts(current.tenant, transition.facts, { newId: this.newId, now: this.now });
    const updated = await this.deps.releases.update(
      current.tenant,
      current.id,
      transition.patch,
      stamped.map((s) => s.record),
    );
    if (!updated) throw new NotFoundError("NOT_FOUND", { id: current.id }, `release '${current.id}' not found.`);
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return updated;
  }
}

// One list row's contribution to a series trend — the shape the domain arithmetic reads.
function seriesPoint(record: ScorecardRecord): SeriesScorecardPoint {
  const rate = headlinePassRate(record);
  return {
    scorecardId: record.id,
    ...(rate !== null ? { passRate: rate } : {}),
    createdAt: record.createdAt,
    ...(record.origin?.serviceVersion !== undefined ? { serviceVersion: record.origin.serviceVersion } : {}),
  };
}
