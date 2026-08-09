import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type GateScoringPin,
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
  type BaselineResolution,
  Product,
  type ProductEditInput,
  type ProductTransition,
  Release,
  type ReleaseEditInput,
  type ReleaseTransition,
  type SeriesGateReading,
  type SeriesScorecardPoint,
  currentScoringPin,
  decisionPassRate,
  productPolicyDigest,
  releasePolicyDocument,
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
  // The series trend/readiness points. Absent = no trend: every series reads "not run yet" — which BLOCKS a
  // required series (not evaluated is never green), never silently passes.
  scorecards?: ScorecardStore;
  // The release gate's evidence seam (arch-review 7 P0): a series' release verdict is the SCORECARD GATE's
  // decision over (baseline, latest) — analytics.diff + evaluateGate, wired at composition. The product
  // layer composes decisions; it never invents truth semantics (the pass-rate arithmetic this replaces
  // bypassed experiment identity, policy identity, scoring revisions, coverage, criticals, trials and FDR).
  // Absent (unit paths) = a comparable pair reads not_comparable — refusing, never guessing.
  //
  // It returns the pins it READ (arch-review 10 P0): the gate captures both records at its one read, and a
  // release that re-derived them from a separate list read stamped its decision with a revision that may not
  // have produced the verdict beside it. The seam hands the decision over whole; this service composes, it
  // does not reassemble.
  seriesGate?: (
    tenant: string,
    baselineId: string,
    candidateId: string,
  ) => Promise<{
    decision: "pass" | "block" | "blocked_missing" | "not_comparable";
    reasons: Array<{ kind: string; detail: string }>;
    baselineScoring?: GateScoringPin;
    candidateScoring?: GateScoringPin;
  }>;
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
    if (fields.series !== undefined) {
      await this.assertSeriesRefs(tenant, fields.series);
      await this.assertNoPlannedReleaseLosesItsGate(tenant, id, fields.series);
    }
    return this.applyTransition(record, Product.from(record).update(fields, actor.subject, this.now()));
  }

  // The SECOND layer of the release-scope fix (arch-review 12 P0). The readiness check is fail-closed — a
  // promised-but-missing series blocks — and this is what makes the failure legible instead of mysterious:
  // the edit that would break a planned release is refused AT the edit, naming the release, rather than
  // discovered later as a release nobody can ship.
  //
  // Both layers exist on purpose. This one is a preflight and can be bypassed (an import, a migration, a
  // future write path, another replica racing), so it can never be the guarantee; the guarantee is the gate.
  // A preflight alone would be a check that happens to run today, and a gate alone would refuse at the worst
  // possible moment with no explanation of what changed.
  private async assertNoPlannedReleaseLosesItsGate(
    tenant: string,
    productId: string,
    nextSeries: readonly ProductSeries[],
  ): Promise<void> {
    const keys = new Set(nextSeries.map((s) => s.key));
    const releases = await this.deps.releases.list(tenant, { productId, status: "planned" });
    for (const release of releases) {
      // What this release COMMITTED to — its frozen promise, or its live selection for one planned before
      // the freeze existed. A release watching "all" has nothing to lose here: dropping a series is a
      // deliberate narrowing of what "all" means, and it kept no promise about a specific axis.
      const promised =
        release.plannedSeriesKeys !== undefined && release.seriesSelection === "explicit"
          ? release.plannedSeriesKeys
          : release.seriesKeys;
      const lost = (promised ?? []).filter((key) => !keys.has(key));
      if (lost.length > 0)
        throw new ConflictError(
          "CONFLICT",
          { product: productId, release: release.id, series: lost },
          `Release "${release.name}" is judged on ${lost.map((k) => `"${k}"`).join(", ")} — removing a series a planned release watches would delete its gate rather than pass it. Re-scope that release first, or cancel it.`,
        );
    }
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
    //
    // ATOMICALLY (arch-review 12 P1). This used to walk: list releases, delete each, delete versions, delete
    // the product — and across replicas that walk has a gap a `createRelease` can insert into, leaving a
    // release under a product that no longer exists and that nothing ever collects. The schema has no foreign
    // keys by choice, which means the aggregate boundary is a transaction's job, and imitating a cascade from
    // application code is exactly where that obligation went missing.
    await this.deps.store.removeAggregate(tenant, id);
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
            const rate = decisionPassRate(row); // stamped-policy aggregate first — same number the release stands on
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
    // ONE product read (arch-review 10 P0) — the policy the decision is EVALUATED under and the policy it
    // RECORDS are now the same document by construction, not by two reads happening to agree.
    const product = await this.get(tenant, record.productId);
    const readiness = await this.readinessUnder(tenant, record, product);
    const transition = Release.from(record).setStatus(
      {
        to: input.status,
        openIssues: readiness.openIssues,
        regressedSeries: readiness.regressedSeries,
        // The ship-time evidence snapshot — the history entry records WHAT the gate saw (per-series
        // verdicts); the live readiness keeps moving after the decision.
        // The evidence this ship stood on — both sides with their scoring pins, so the decision is
        // reproducible and the NEXT release can anchor on this exact candidate instead of re-searching by
        // time (a post-ship re-score would otherwise change what "last time's baseline" means).
        seriesDecisions: readiness.series.map((s) => ({
          key: s.key,
          verdict: s.verdict,
          required: product.series.find((entry: ProductSeries) => entry.key === s.key)?.requiredForRelease !== false,
          ...(s.reasons?.length ? { reasons: s.reasons } : {}),
          ...(s.baseline
            ? {
                baseline: {
                  scorecardId: s.baseline.scorecardId,
                  ...(s.baseline.scoring ? { scoring: s.baseline.scoring } : {}),
                },
              }
            : {}),
          ...(s.latest
            ? {
                candidate: {
                  scorecardId: s.latest.scorecardId,
                  ...(s.latest.scoring ? { scoring: s.latest.scoring } : {}),
                },
              }
            : {}),
        })),
        // The policy DOCUMENT, not just its digest (arch-review 10 P0). A digest of a mutable record can
        // detect that the policy changed and can never say what it was — so a post-mortem on a shipped
        // release could not answer "which series gated this, and had a bootstrap been approved?" once the
        // product had been edited. Scoped to the watched series: the policy this decision stood on.
        productPolicy: releasePolicyDocument(product, record),
        productPolicyDigest: productPolicyDigest(product, record),
        ...(input.force !== undefined ? { force: input.force } : {}),
      },
      actor.subject,
      this.now(),
    );
    // …and the write is fenced on the PRODUCT's version too (arch-review 10 P0). The release's own version
    // cannot protect a policy that lives in a different aggregate: an admin flipping a series to required
    // while this decision was being made left the release row untouched, so the guard passed and a decision
    // evaluated under the old policy committed as if it had seen the new one. The guard is evaluated in the
    // write statement, the same shape as the scoring fence.
    return this.applyReleaseTransition(record, transition, product);
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

  // How ready the release is: open linked issues + every watched series' RELEASE VERDICT — the SCORECARD
  // GATE's decision over (baseline, latest), anchored at the PREVIOUS released release. "Did we get worse
  // since we last shipped" is a question only the gate machinery has the right to answer (arch-review 7 P0):
  // a bare pass-rate comparison bypassed identity/policy/coverage and read absence of evidence as green.
  async readiness(tenant: string, release: ReleaseRecord): Promise<ReleaseReadiness> {
    return this.readinessUnder(tenant, release, await this.get(tenant, release.productId));
  }

  // …evaluated under a product the CALLER read (arch-review 10 P0). `setReleaseStatus` used to call
  // `readiness()` and then read the product AGAIN to record the policy, so the decision could be evaluated
  // under policy P1 and recorded as standing on P2 — a series flipped to `requiredForRelease: true` in
  // between produced a history entry reading "required, not_evaluated" on a release that shipped unforced.
  // One read, threaded; the version guard on the write is what makes it hold under concurrency.
  private async readinessUnder(
    tenant: string,
    release: ReleaseRecord,
    product: ProductRecord,
  ): Promise<ReleaseReadiness> {
    const openIssues =
      this.deps.issues === undefined
        ? 0
        : (
            await this.deps.issues.list(tenant, {
              link: { type: "release", id: release.id },
              statuses: OPEN_ISSUE_STATUSES,
            })
          ).length;
    const previous = await this.previousShip(tenant, release);
    const anchor = previous?.releasedAt;
    const latestBySeries = new Map<string, SeriesScorecardPoint>();
    // WHY each series has (or lacks) a baseline, not merely whether (arch-review 10 P0). Absence used to be
    // one value with three meanings, and the domain read all three as "first ship" — so an approved
    // bootstrap silently covered a DELETED baseline. The service resolves which case holds; the domain
    // decides what each one means.
    const baselineBySeries = new Map<string, BaselineResolution>();
    const gateBySeries = new Map<string, SeriesGateReading>();
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
        // The PREVIOUS SHIP'S OWN CANDIDATE is the baseline — the exact evidence that ship stood on, pin
        // included. Only when it recorded none (a release from before decisions were recorded) does the
        // time search stand in, and then the comparison is honestly anchored on a re-derived guess.
        const pinned = this.baselineFromDecision(previous, series.key);
        const fromDecision = pinned ? rows.find((row) => row.id === pinned.scorecardId) : undefined;
        // A pinned baseline that CANNOT BE FOUND is missing historical evidence, not licence to compare
        // against a different scorecard — and NOT a first ship either, which is the distinction the
        // resolution type exists to keep (a `not_comparable` gate reading could not say it, because the
        // domain never looked at the gate when the baseline was absent). The time search stands in only for
        // ships that recorded no pin at all.
        if (pinned !== undefined && fromDecision === undefined) {
          baselineBySeries.set(series.key, {
            kind: "missing_historical_evidence",
            ...(pinned.scoring !== undefined ? { pin: pinned.scoring } : { pin: undefined }),
            scorecardId: pinned.scorecardId,
          });
          continue;
        }
        const baseline =
          fromDecision ??
          (pinned === undefined && anchor !== undefined ? rows.find((r) => r.createdAt <= anchor) : undefined);
        if (baseline === undefined) continue; // no prior ship at all — the domain's first-ship default
        const point = seriesPoint(baseline);
        // …and if the pinned scorecard WAS re-scored, the comparison below cannot be the one the last ship
        // stood on. The gate reads a scorecard by id and gets whatever judgment lives there NOW; the pinned
        // revision's plane is not addressable until scoring planes become immutable revisions
        // (docs/architecture/scoring-plane-revisions.md). Comparing today's judgment while the decision
        // record claims a pinned one is the lie this pin existed to prevent, so it refuses instead.
        const livePin = point.scoring;
        if (
          pinned?.scoring !== undefined &&
          livePin !== undefined &&
          livePin.scorePlaneDigest !== pinned.scoring.scorePlaneDigest
        ) {
          baselineBySeries.set(series.key, {
            kind: "revision_unavailable",
            pin: pinned.scoring,
            current: livePin,
            scorecardId: baseline.id,
          });
          continue;
        }
        // The pin the SHIP recorded wins over the record's current pin: if the scorecard was re-scored since,
        // "what we compared against last time" is the older judgment, and saying so is the point.
        baselineBySeries.set(series.key, {
          kind: "resolved",
          point: pinned?.scoring ? { ...point, scoring: pinned.scoring } : point,
        });
        // The gate reading — only where a comparable pair exists; the domain owns every other state
        // (not_evaluated / no_baseline / seam-absent not_comparable).
        if (latest !== undefined && this.deps.seriesGate !== undefined) {
          try {
            const decision = await this.deps.seriesGate(tenant, baseline.id, latest.id);
            gateBySeries.set(series.key, {
              verdict: decision.decision,
              ...(decision.reasons.length > 0 ? { reasons: decision.reasons.map((r) => r.detail) } : {}),
              // The pins the GATE read — see SeriesGateReading. Recorded over the list's, so the decision
              // names the judgment it decided on.
              ...(decision.baselineScoring !== undefined ? { baselineScoring: decision.baselineScoring } : {}),
              ...(decision.candidateScoring !== undefined ? { candidateScoring: decision.candidateScoring } : {}),
            });
          } catch (err) {
            // A comparison that cannot run (mid-rescore refusal, a deleted record) REFUSES — the honest
            // reason rides; it never silently reads as pass.
            gateBySeries.set(series.key, {
              verdict: "not_comparable",
              reasons: [err instanceof Error ? err.message : String(err)],
            });
          }
        }
      }
    }
    return releaseReadiness(release, product, latestBySeries, baselineBySeries, gateBySeries, openIssues);
  }

  // The instant the product last shipped BEFORE this release — the baseline's anchor. For a released release
  // that is the ship before its own; for a planned one, the newest ship so far. `<=` because the release
  // itself is already excluded by id — a previous ship landing on this exact instant must still anchor.
  private async baselineAnchor(tenant: string, release: ReleaseRecord): Promise<string | undefined> {
    const previous = await this.previousShip(tenant, release);
    return previous?.releasedAt;
  }

  // The ship this release compares against — the whole record, because its DECISION is the anchor, not just
  // its timestamp (see baselineFromDecision).
  private async previousShip(tenant: string, release: ReleaseRecord): Promise<ReleaseRecord | undefined> {
    const released = await this.deps.releases.list(tenant, { productId: release.productId, status: "released" });
    const ceiling = release.releasedAt ?? this.now();
    return released
      .filter((row) => row.id !== release.id && row.releasedAt !== undefined && row.releasedAt <= ceiling)
      .sort((a, b) => (a.releasedAt ?? "").localeCompare(b.releasedAt ?? ""))
      .at(-1);
  }

  // The baseline the LAST SHIP actually stood on for this series (arch-review 8 P1). Resolving it by time
  // re-searches "the newest scorecard created before that instant" and then reads it AS IT IS NOW — so a
  // post-ship re-score silently changed what "the thing we shipped against" means, and a comparison could
  // be drawn against a judgment no release ever saw. The previous decision recorded its candidate with a
  // scoring pin; that reference is the anchor. Absent (a ship from before decisions were recorded) → the
  // caller falls back to the time search, honestly degraded rather than pretending to a pin it never had.
  private baselineFromDecision(
    previous: ReleaseRecord | undefined,
    seriesKey: string,
  ): { scorecardId: string; scoring?: GateScoringPin } | undefined {
    const shipped = previous?.history?.filter((h) => h.event === "released").at(-1);
    const decisions = (
      shipped?.detail as
        | { seriesDecisions?: Array<{ key: string; candidate?: { scorecardId: string; scoring?: GateScoringPin } }> }
        | undefined
    )?.seriesDecisions;
    return decisions?.find((d) => d.key === seriesKey)?.candidate;
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
      // The version this transition was computed FROM (arch-review 11 P1). The store rewrites the whole row,
      // so two edits from one snapshot silently drop the earlier one — and for a product the dropped field
      // may be `series`, which is the release constitution. A concurrent edit must lose visibly.
      { expectVersion: current.version ?? 0 },
    );
    if (updated === undefined) {
      const live = await this.deps.store.get(current.tenant, current.id);
      if (live !== undefined)
        throw new ConflictError(
          "CONFLICT",
          { product: current.id, expectedVersion: current.version ?? 0, actualVersion: live.version ?? 0 },
          "this product was edited while your change was being prepared — re-read it and apply your change again (writing now would silently revert the other edit).",
        );
    }
    if (!updated) throw new NotFoundError("NOT_FOUND", { id: current.id }, `product '${current.id}' not found.`);
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return updated;
  }

  private async applyReleaseTransition(
    current: ReleaseRecord,
    transition: ReleaseTransition,
    // The product this decision was evaluated under, when there was one — its version becomes a cross-row
    // condition on the write (arch-review 10 P0). Absent for plain edits, which stand on no policy.
    product?: ProductRecord,
  ): Promise<ReleaseRecord> {
    const stamped = stampFacts(current.tenant, transition.facts, { newId: this.newId, now: this.now });
    // The domain judged this transition legal FROM the status in `current`, so the write commits only from
    // that status (arch-review 8 P1). Without it two replicas could both read `planned`, legally decide
    // `released` and `cancelled`, and let the last write win — leaving a `released` fact in the outbox over
    // a cancelled row. A guard miss is a concurrent decision, not a missing record, and says so.
    const updated = await this.deps.releases.update(
      current.tenant,
      current.id,
      transition.patch,
      stamped.map((s) => s.record),
      // Version, not just status (arch-review 9 P0). A release stays EDITABLE while planned, so a decision
      // evaluated over seriesKeys=[quality] could commit onto a record another replica had meanwhile changed
      // to [quality, safety] — status was still `planned`, the guard passed, and the shipped record watched a
      // series its readiness never looked at. The version moves on ANY write, so an edit invalidates the
      // decision that did not see it.
      {
        expectStatus: current.status,
        expectVersion: current.version ?? 0,
        // …and the PRODUCT's policy must still be the one this decision read. A different aggregate, so the
        // release's own version cannot speak for it.
        ...(product !== undefined ? { expectProduct: { id: product.id, version: product.version ?? 0 } } : {}),
      },
    );
    if (updated === undefined) {
      const live = await this.deps.releases.get(current.tenant, current.id);
      if (live !== undefined) {
        const liveProduct = product !== undefined ? await this.deps.store.get(current.tenant, product.id) : undefined;
        const policyMoved = product !== undefined && (liveProduct?.version ?? 0) !== (product.version ?? 0);
        throw new ConflictError(
          "CONFLICT",
          {
            release: current.id,
            expected: current.status,
            actual: live.status,
            expectedVersion: current.version ?? 0,
            actualVersion: live.version ?? 0,
            ...(policyMoved
              ? { productVersion: { expected: product?.version ?? 0, actual: liveProduct?.version ?? 0 } }
              : {}),
          },
          policyMoved
            ? "this product's release policy was edited while the decision was being made — which series gate (and whether a bootstrap is approved) may differ from the ones this readiness evaluated; re-read it and decide again."
            : live.status !== current.status
              ? `this release moved to ${live.status} while the decision was being made — re-read it and decide again.`
              : "this release was edited while the decision was being made — its watched series may differ from the ones this readiness evaluated; re-read it and decide again.",
        );
      }
    }
    if (!updated) throw new NotFoundError("NOT_FOUND", { id: current.id }, `release '${current.id}' not found.`);
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return updated;
  }
}

// One list row's contribution to a series trend — the shape the domain arithmetic reads.
function seriesPoint(record: ScorecardRecord): SeriesScorecardPoint {
  // The stamped-policy verdict aggregate when the record carries one (arch-review 7 §4) — the release
  // decision and the case dialog must never rank a metric differently; headline is the legacy fallback.
  const rate = decisionPassRate(record);
  // WHICH judgment this point is — the same pin a gate decision records. Without it a release decision
  // names a scorecard id, and an id stops identifying a judgment the moment a re-score lands.
  const scoring = currentScoringPin(record.scoring);
  return {
    scorecardId: record.id,
    ...(rate !== null ? { passRate: rate } : {}),
    createdAt: record.createdAt,
    ...(record.origin?.serviceVersion !== undefined ? { serviceVersion: record.origin.serviceVersion } : {}),
    ...(scoring ? { scoring } : {}),
  };
}
