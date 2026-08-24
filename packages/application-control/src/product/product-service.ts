import { randomBytes } from "node:crypto";
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
  type ReleaseComponent,
  type ReleaseReadiness,
  type ReleaseRecord,
  type ReleaseStatus,
  type ScorecardRecord,
  type ShippedComponent,
  UpstreamError,
  isProductSlugRef,
} from "@everdict/contracts";
import type {
  ProductDetailResponse,
  ProductTimelineCapabilityVersion,
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
  type ResolvedSeriesContract,
  type SeriesContractResolution,
  type SeriesGateReading,
  type SeriesScorecardPoint,
  contentDigest,
  currentScoringPin,
  decisionPassRate,
  productEvaluationDefinitionDigest,
  productPolicyDigest,
  productReleasePolicyDigest,
  productSlugStem,
  releasePolicyDocument,
  releaseReadiness,
  resolveWatchedSeries,
  seriesNeedingEvidence,
  watchedSeries,
} from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { ProductStore, ProductVersionStore, ReleaseStore } from "../ports/product-store.js";
import type { CapabilityGenerationStore } from "../ports/product-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { findProductByRef } from "./product-ref.js";
import type { SeriesEvaluator, SeriesRunOutcome } from "./series-evaluator.js";

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

// How many times a slug mint retries against the uniqueness index before giving up (see mintSlug).
const SLUG_MINT_ATTEMPTS = 6;

// How far ahead the axis reaches: the furthest date the product still INTENDS to hit, or the present instant
// when it intends nothing. Only a PLANNED release counts — a cancelled one is a date nobody is working toward,
// and stretching the axis to it would spend the whole width on a span where nothing will ever be drawn; a
// released one already sits at its `releasedAt`, in the past. The target is a calendar date, so the horizon is
// the END of that day: the marker then lands just inside the axis instead of half-clipped on its edge.
function timelineHorizon(now: string, releases: readonly ReleaseRecord[]): string {
  const targets = releases
    .filter((release) => release.status === "planned" && release.targetDate !== undefined)
    .map((release) => `${release.targetDate}T23:59:59.999Z`);
  return targets.reduce((furthest, target) => (target > furthest ? target : furthest), now);
}

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
  // The composition this release ships — validated against the product's tracked services by the aggregate.
  components?: ReleaseComponent[];
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
  // The capability resolution generations a ship's commit conditions on (mig 0163). Optional: a deployment
  // without it keeps the other fences and the contract re-verify — a smaller guarantee, never a silent one.
  capabilityGenerations?: CapabilityGenerationStore;
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
  // Per-version registration instants of a capability a watch series declares — the timeline's "what did the
  // evaluation contract do while the services moved" lane. A seam (like resolveSeriesContract) because
  // resolving names belongs to the registries; the product layer must not learn their shapes. Absent = the
  // capability lane serves empty — absent evidence, never "nothing happened". A dangling id answers an empty
  // map (registry semantics), so a series watching a deleted capability draws nothing rather than failing
  // the whole read.
  capabilityVersions?: (
    tenant: string,
    kind: "harness" | "dataset" | "judge",
    id: string,
  ) => Promise<Record<string, string>>;
  // Resolve a series' CONCRETE evaluation contract — the dataset/harness/judge versions a run of it would
  // actually use right now (arch-review 13 P0). A seam, like `seriesGate`, because resolving `latest`
  // belongs to the registries and the product layer must not learn their shapes.
  //
  // Absent = this deployment cannot answer "what does this series ask today", and the freshness check
  // ABSTAINS for every series. That is the honest degradation: an unenforceable invariant we can name beats
  // a made-up one. It is also what keeps unit paths (and any deployment without registries) working.
  resolveSeriesContract?: (tenant: string, series: ProductSeries) => Promise<SeriesContractResolution>;
  // Turning a watch series into a scorecard — the SAME collaborator the version sync fans out through, so a
  // batch a member asked for and a batch an import produced are stamped by one piece of code. Absent = this
  // deployment cannot run a series on demand: declaring one seeds nothing and the on-demand route is refused,
  // which is the honest reading of a control plane with no eval plane behind it.
  seriesEvaluator?: SeriesEvaluator;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

// READING A FENCE IS PART OF THE DECISION, not preparation for it. Every condition a terminal commit stands
// on has to be ESTABLISHED — and a store that is wired but cannot answer has established nothing. Degrading
// to "no condition" is the failure mode this whole generation of review has been removing: it is silent, it
// is in the direction of green, and it happens at the transition a workspace cannot take back.
//
// UpstreamError rather than Conflict: nothing about the release is wrong, the platform could not read its own
// state. The caller retries.
async function fenceRead<T>(what: string, release: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { release, fence: what },
      `Refusing to ship: ${what} could not be read (${err instanceof Error ? err.message : String(err)}), so this decision cannot state the conditions it commits under. A ship that skips a fence it could not read is not a smaller guarantee — it is a different one.`,
    );
  }
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
      slug: await this.mintSlug(input.tenant, input.name),
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
    await this.seedDeclaredSeries(
      record,
      record.series.map((series) => series.key),
      input.createdBy,
    );
    return record;
  }

  async list(tenant: string): Promise<ProductRecord[]> {
    return this.deps.store.list(tenant);
  }

  // THE ADDRESS IS FREE, THE NAME IS NOT (mig 0169). A slug is derived from the name and must be unique within
  // the workspace, so minting is a read the domain cannot do: the stem is a pure function of the name, and
  // whether it is taken is a question only the store can answer.
  //
  // The discriminator is random rather than a counter. `-2` looks tidier and is a read-modify-write: two
  // creates racing on the same stem both see `-2` free and one of them loses to the unique index. Random hex
  // makes the retry independent, which is what lets the loop be short.
  private async mintSlug(tenant: string, name: string): Promise<string> {
    const stem = productSlugStem(name);
    for (let attempt = 0; attempt < SLUG_MINT_ATTEMPTS; attempt++) {
      const candidate = attempt === 0 ? stem : `${stem.slice(0, 55)}-${randomBytes(4).toString("hex")}`;
      // A candidate that reads as an id would shadow one index with the other, and no name should be able to
      // claim an address that belongs to the id space.
      if (isProductSlugRef(candidate) && (await this.deps.store.getBySlug(tenant, candidate)) === undefined)
        return candidate;
    }
    // The loop only exhausts if the store is answering "taken" for random 32-bit suffixes, which is not a
    // collision — it is a store that cannot be trusted to say what is free. Refusing beats minting an address
    // the unique index will reject anyway, with the create half-done.
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { tenant, name },
      "Could not mint a free address for this product — the slug index kept reporting every candidate as taken.",
    );
  }

  // A product answers to two names: its slug (what a URL carries) and its id (what every stored pointer
  // carries). Resolution lives in the SERVICE rather than in the routes, so HTTP, MCP and every headless
  // caller accept both forms without any of them learning the rule — the team-key precedent.
  async get(tenant: string, ref: string): Promise<ProductRecord> {
    const record = await findProductByRef(this.deps.store, tenant, ref);
    if (!record) throw new NotFoundError("NOT_FOUND", { id: ref }, `product '${ref}' not found.`);
    return record;
  }

  // The record plus what its screen opens on: the releases (every one — a product has a handful) and the
  // visible slice of the version ledger. The trend itself is the timeline read's job (heavier, windowed).
  async detail(tenant: string, ref: string): Promise<ProductDetailResponse> {
    const record = await this.get(tenant, ref);
    // Children are keyed by the product's ID, never by the ref the caller happened to address it with.
    const [releases, versions] = await Promise.all([
      this.deps.releases.list(tenant, { productId: record.id }),
      this.deps.versions.list(tenant, { productId: record.id, limit: DETAIL_VERSION_LIMIT }),
    ]);
    return { ...record, releases, versions };
  }

  async update(tenant: string, ref: string, fields: ProductEditInput, actor: ProductActor): Promise<ProductRecord> {
    const record = await this.get(tenant, ref);
    if (fields.series !== undefined) {
      await this.assertSeriesRefs(tenant, fields.series);
      await this.assertNoPlannedReleaseLosesItsGate(tenant, record.id, fields.series);
    }
    // WHAT THIS EDIT OWES A RUN, decided against the record we are replacing — after the write there is
    // nothing left to compare against, and the answer is the whole point of seeding.
    const owed = fields.series === undefined ? [] : seriesNeedingEvidence(record.series, fields.series);
    const updated = await this.applyTransition(record, Product.from(record).update(fields, actor.subject, this.now()));
    await this.seedDeclaredSeries(updated, owed, actor.subject);
    return updated;
  }

  // A DECLARATION OWES ITSELF A FIRST ANSWER. Nothing but a version import used to fan a series out, so a
  // series declared on a product whose history was already backfilled had no evidence until upstream shipped
  // again — while the release gate read that same emptiness as `not_evaluated` and blocked the ship. Declaring
  // a series is the act that says "this is how we judge the product from now on", and the run belongs to that
  // act, not to whatever happens to arrive next.
  //
  // Best-effort ON PURPOSE, and the one place in this file where that is not a silent failure: the write has
  // already landed and must not be undone by a batch that could not be submitted, and the failure is VISIBLE —
  // the series draws an empty trend beside an explicit run control, and a required one blocks the release with
  // `not_evaluated` until somebody presses it. `autoEval.enabled` gates it because this is the automatic half;
  // the on-demand run below is a person asking and honours no such switch.
  private async seedDeclaredSeries(product: ProductRecord, keys: readonly string[], by: string): Promise<void> {
    if (keys.length === 0 || !product.autoEval.enabled || this.deps.seriesEvaluator === undefined) return;
    await this.deps.seriesEvaluator
      .run(product.tenant, product, { submittedBy: by, trigger: "series_declared", keys })
      .catch(() => undefined);
  }

  // Run a product's watch series NOW, because somebody asked. The counterpart to Sync: that one refreshes the
  // version axis, this one refreshes the QUALITY axis, and until it existed the second had no manual door at
  // all. Absent keys = everything the product currently watches; a named key that the product does not
  // declare is a 404 rather than a silently empty fan-out.
  async runSeries(
    tenant: string,
    ref: string,
    keys: readonly string[] | undefined,
    actor: ProductActor,
  ): Promise<SeriesRunOutcome> {
    const product = await this.get(tenant, ref);
    if (this.deps.seriesEvaluator === undefined)
      throw new NotFoundError(
        "NOT_FOUND",
        { product: product.id },
        "This deployment has no evaluation plane, so a series cannot be run.",
      );
    if (product.series.length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { product: product.id },
        "This product declares no watch series, so there is nothing to evaluate. Declare one first.",
      );
    return this.deps.seriesEvaluator.run(tenant, product, {
      submittedBy: actor.subject,
      trigger: "manual",
      ...(keys !== undefined ? { keys } : {}),
    });
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
      // the freeze existed.
      //
      // The frozen promise counts for BOTH selection modes (arch-review 13). This used to consult it only
      // for `explicit`, which put two readings of one invariant in the codebase: the gate says `all` froze
      // what "all" meant that day (and turns a vanished key into `scope_invalid`), while the preflight said
      // `all` promised nothing about any particular axis and let the edit through. The result was a product
      // edit that succeeded and a planned release that became un-shippable a moment later, with the
      // explanation on the wrong side of the transaction — which is the exact job the preflight exists for.
      // Adding a series is still free under `all`; only removing a promised one is refused.
      const promised = release.plannedSeriesKeys ?? release.seriesKeys;
      const lost = (promised ?? []).filter((key) => !keys.has(key));
      if (lost.length > 0)
        throw new ConflictError(
          "CONFLICT",
          { product: productId, release: release.id, series: lost },
          `Release "${release.name}" is judged on ${lost.map((k) => `"${k}"`).join(", ")} — removing a series a planned release watches would delete its gate rather than pass it. Re-scope that release first, or cancel it.`,
        );
    }
  }

  async remove(tenant: string, ref: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const record = await this.get(tenant, ref);
    if (record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id: record.id, action: "products:delete" },
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
    await this.deps.store.removeAggregate(tenant, record.id);
  }

  async listVersions(
    tenant: string,
    ref: string,
    filter?: { service?: string; limit?: number },
  ): Promise<ProductServiceVersionRecord[]> {
    const product = await this.get(tenant, ref); // 404 for another workspace's product before serving its ledger
    return this.deps.versions.list(tenant, {
      productId: product.id,
      ...(filter?.service !== undefined ? { service: filter.service } : {}),
      ...(filter?.limit !== undefined ? { limit: filter.limit } : {}),
    });
  }

  // The product's time axis in ONE read (the pulse's treatment: composed from stores, drawn by the web):
  // releases (all — a handful, and a planned date may sit beyond any window), the windowed version ledger,
  // each watch series' scorecard points oldest-first, and the lifecycle markers of linked issues.
  //
  // The window's END IS THE PRODUCT'S HORIZON, not the present instant: what a product timeline is FOR is the
  // conversation about the next ship, and a release is planned before it happens. An axis stopping at `now`
  // cannot place that marker at all — every future target collapsed onto the right edge, so three releases
  // planned across two months drew as one pile on the same day. The horizon is therefore the furthest date the
  // product has committed to, and `now` rides along in the window so the reader can still tell the part of the
  // axis that HAPPENED from the part that is intended.
  async timeline(
    tenant: string,
    ref: string,
    window?: { from?: string; to?: string },
  ): Promise<ProductTimelineResponse> {
    const product = await this.get(tenant, ref);
    const id = product.id; // children are keyed by the id, whichever form the caller addressed the product with
    const now = this.now();
    const releases = await this.deps.releases.list(tenant, { productId: id });
    const to = window?.to ?? timelineHorizon(now, releases);
    // The visible PAST is a quarter measured back from the anchor the caller named — or from `now`, never from
    // the horizon: deriving it from `to` would slide the window forward by however far the next release sits in
    // the future and silently drop the versions and batches the trend is being read against.
    const from = window?.from ?? new Date(Date.parse(window?.to ?? now) - TIMELINE_DEFAULT_WINDOW_MS).toISOString();
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
      const collect = (rows: readonly IssueRecord[], via: ProductTimelineIssue["via"], releaseId?: string): void => {
        for (const issue of rows) {
          if (seen.has(issue.id)) continue;
          seen.add(issue.id);
          issues.push({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            status: issue.status,
            via,
            createdAt: issue.createdAt,
            ...(issue.resolution?.at !== undefined ? { resolvedAt: issue.resolution.at } : {}),
            ...(issue.resolution?.scorecardId !== undefined
              ? { resolvedByScorecardId: issue.resolution.scorecardId }
              : {}),
            ...(releaseId !== undefined ? { releaseId } : {}),
          });
        }
      };
      collect(await this.deps.issues.list(tenant, { link: { type: "product", id } }), "product");
      for (const release of releases)
        collect(
          await this.deps.issues.list(tenant, { link: { type: "release", id: release.id } }),
          "release",
          release.id,
        );
      // …AND the issues this product's own EVIDENCE is about (the third relationship, and the one nobody has to
      // remember to declare). A workspace files an issue against a regression, links the scorecard that shows
      // it, and closes it with the scorecard that proves the fix — none of which touches the product record, so
      // a timeline reading explicit links alone drew an empty issue lane on exactly the products with the most
      // to say. The scorecards are the ones already collected for the trend above, so the extra cost is one
      // query, and the window that bounds the trend bounds this too.
      const evidence = [...new Set(series.flatMap((entry) => entry.points.map((point) => point.scorecardId)))];
      if (evidence.length > 0) collect(await this.deps.issues.list(tenant, { scorecards: evidence }), "evidence");
    }
    // …AND what the EVALUATION CONTRACT did while the services moved: a new version of a watched harness,
    // dataset or judge changes what the next auto-run asks, which makes it an event on this axis exactly like
    // a service release. Derived from the series the product declares TODAY — a capability it stopped
    // watching is no longer this product's news — and windowed like the version ledger.
    const capabilities: ProductTimelineCapabilityVersion[] = [];
    if (this.deps.capabilityVersions !== undefined) {
      const watched = new Map<string, { kind: "harness" | "dataset" | "judge"; id: string; seriesKeys: string[] }>();
      const watch = (kind: "harness" | "dataset" | "judge", capabilityId: string, seriesKey: string): void => {
        const key = `${kind}:${capabilityId}`;
        const entry = watched.get(key) ?? { kind, id: capabilityId, seriesKeys: [] };
        if (!entry.seriesKeys.includes(seriesKey)) entry.seriesKeys.push(seriesKey);
        watched.set(key, entry);
      };
      for (const entry of product.series) {
        watch("dataset", entry.dataset.id, entry.key);
        watch("harness", entry.harness.id, entry.key);
        for (const judge of entry.judges) watch("judge", judge.id, entry.key);
      }
      for (const ref of watched.values()) {
        const dates = await this.deps.capabilityVersions(tenant, ref.kind, ref.id);
        for (const [version, registeredAt] of Object.entries(dates)) {
          if (registeredAt >= from && registeredAt <= to)
            capabilities.push({ kind: ref.kind, id: ref.id, version, registeredAt, seriesKeys: ref.seriesKeys });
        }
      }
      capabilities.sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
    }
    return { window: { from, to, now }, releases, versions, series, issues, capabilities };
  }

  // --- Releases -----------------------------------------------------------------------------------------------

  async createRelease(input: CreateReleaseInput): Promise<ReleaseRecord> {
    const product = await this.get(input.tenant, input.productId);
    const record = Release.newRelease({
      id: this.newId(),
      tenant: input.tenant,
      // The RESOLVED id, never the caller's ref: a release addressed through the product's slug would
      // otherwise store the slug as its parent key, and every read that joins on `productId` — the gate's
      // issue count included — would miss it. An address is for arriving; a stored pointer is for joining.
      productId: product.id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      ...(input.seriesKeys !== undefined ? { seriesKeys: input.seriesKeys } : {}),
      ...(input.components !== undefined ? { components: input.components } : {}),
      productSeriesKeys: product.series.map((series) => series.key),
      productServiceNames: product.services.map((service) => service.name),
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
  async listReleases(tenant: string, ref?: string): Promise<ReleaseRecord[]> {
    // Resolved first, then filtered on the resolved id — the 404 scope and the join key are the same read.
    const productId = ref !== undefined ? (await this.get(tenant, ref)).id : undefined;
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
        product.services.map((service) => service.name),
      ),
    );
  }

  // The release gate. The service counts (it owns the stores); the domain decides what the counts mean.
  // WHICH capability documents this decision's contracts were resolved from — the dataset, the harness, and
  // every selected judge of every watched series. Rubrics and models sit one level deeper, inside a judge's
  // own closure, and are covered by the contract re-verify rather than by this fence: enumerating them would
  // mean resolving each judge document here, which is a second resolution of the thing we are fencing.
  private static capabilityRefsFor(
    product: ProductRecord,
    release: ReleaseRecord,
  ): Array<{ kind: "dataset" | "harness" | "judge"; id: string }> {
    const refs = new Map<string, { kind: "dataset" | "harness" | "judge"; id: string }>();
    for (const series of resolveWatchedSeries(product, release).series) {
      refs.set(`dataset:${series.dataset.id}`, { kind: "dataset", id: series.dataset.id });
      refs.set(`harness:${series.harness.id}`, { kind: "harness", id: series.harness.id });
      for (const judge of series.judges ?? []) refs.set(`judge:${judge.id}`, { kind: "judge", id: judge.id });
    }
    return [...refs.values()];
  }

  // The NESTED documents a resolved contract named — read off the CARRIED artifact rather than by resolving
  // the judges a second time (arch-review 23 P0-3). The closure already states them as `id@version` refs; a
  // second resolution would be a second answer to a question this decision has already answered, which is
  // the reconstruction this generation of review has been removing everywhere else.
  private static nestedCapabilityRefs(
    contracts: Map<string, SeriesContractResolution> | undefined,
  ): Array<{ kind: "rubric" | "model" | "harness"; id: string }> {
    // READ OFF THE RESOLUTION'S OWN READ-SET (arch-review 24). This used to parse the sealed refs — "does the
    // string contain an `@`" — which made a decision's vocabulary depend on a spelling convention: a literal
    // model name carrying one was fenced as a registry document, and nothing in the type system could say
    // which of the two a given string was. The resolver knows, because it holds the binding; it now says.
    const refs = new Map<string, { kind: "rubric" | "model" | "harness"; id: string }>();
    for (const resolution of contracts?.values() ?? []) {
      if (resolution.status !== "resolved") continue;
      for (const doc of resolution.documents) refs.set(`${doc.kind}:${doc.id}`, doc);
    }
    return [...refs.values()];
  }

  // The plan's components, each resolved to the exact ledger row it names. A `{service, version}` pair is not
  // historical identity once the ledger is stream-aware: repointing a service at another repository means the
  // same name tracks a different stream, and both streams can publish `v1.0.0`. What a shipped release must
  // stay able to answer is WHICH one — so the row's id and its stream travel with the frozen composition.
  //
  // A version nobody decided freezes as `unplanned`; a version that names no ledger row freezes as
  // `unresolved`. Neither is refused: a release may legitimately ship a component whose version was set by
  // hand, and refusing at the ship would turn a bookkeeping gap into a blocked release. Recording WHICH of
  // the three it was is what keeps the history honest.
  private async resolveShippedComponents(tenant: string, record: ReleaseRecord): Promise<ShippedComponent[]> {
    const planned = record.components ?? [];
    if (planned.length === 0) return [];
    const out: ShippedComponent[] = [];
    for (const component of planned) {
      if (component.version === undefined) {
        out.push({ service: component.service, resolution: "unplanned" });
        continue;
      }
      // A LEDGER THAT COULD NOT BE READ IS NOT AN EMPTY LEDGER (arch-review 25 P1). `catch(() => [])` made a
      // transient outage indistinguishable from "this version does not exist", and the difference was then
      // frozen into the ship's permanent record. The ship still proceeds — a bookkeeping read must not block
      // a release — but it records what actually happened.
      const rows = await this.deps.versions
        .list(tenant, { productId: record.productId, service: component.service })
        .catch(() => undefined);
      if (rows === undefined) {
        out.push({
          service: component.service,
          ...(component.version !== undefined ? { version: component.version } : {}),
          resolution: "unavailable",
        });
        continue;
      }
      // RESOLUTION MAY REFINE AMBIGUITY ONLY WHEN THE INPUT UNIQUELY IDENTIFIES THE RESULT (arch-review 22
      // P1). The plan may pin the row the picker offered; otherwise `{service, version}` is matched, and that
      // pair does not uniquely name a row once a service can be repointed at another repository. Taking the
      // first match — which the store returns newest-first — would write "this is the exact row that
      // shipped" into history on the strength of a sort order.
      // ONE INVARIANT, ONE OWNER (arch-review 23 P1). When a plan carries both a row id and a version string,
      // the ROW is the identity and the string is a label of it — so the two disagreeing is a malformed claim,
      // not a preference to resolve. Recording `versionRecordId: row-for-v1` beside `version: v2` would put
      // two authoritative-looking identities inside one historical fact.
      const pinned = component.versionRecordId;
      if (pinned !== undefined) {
        const row = rows.find((r) => r.id === pinned);
        const disagrees = row !== undefined && component.version !== undefined && row.version !== component.version;
        out.push({
          service: component.service,
          ...(component.version !== undefined ? { version: component.version } : {}),
          ...(row !== undefined && !disagrees ? { versionRecordId: row.id } : {}),
          ...(row?.streamKey !== undefined && !disagrees ? { streamKey: row.streamKey } : {}),
          resolution: disagrees ? "conflicting" : row !== undefined ? "ledger" : "unresolved",
        });
        continue;
      }
      // No pin: the legacy shape. A single match is the best available reading and says so — "the ledger holds
      // exactly one row with this version" is not the same statement as "the author meant this row".
      const matches = rows.filter((r) => r.version === component.version);
      const row = matches.length === 1 ? matches[0] : undefined;
      out.push({
        service: component.service,
        version: component.version,
        ...(row !== undefined ? { versionRecordId: row.id } : {}),
        ...(row?.streamKey !== undefined ? { streamKey: row.streamKey } : {}),
        resolution: row !== undefined ? "inferred" : matches.length > 1 ? "ambiguous" : "unresolved",
      });
    }
    return out;
  }

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
    // The contracts this decision is about to stand on — resolved ONCE and carried into both the readiness
    // evaluation and the recorded decision, so the ship cannot record a question different from the one it
    // evaluated (arch-review 14 §9).
    // READ BEFORE the resolution reads anything — a mutation that lands during the read is one this decision
    // may or may not have seen, and "may have" is not a state a fence gets to assume away.
    // A FENCE THAT COULD NOT BE READ IS NOT AN ABSENT FENCE. Swallowing these read failures turned "I could
    // not find out whether the world moved" into "this decision needs no such condition", and the ship then
    // committed under a strictly weaker guard than the one this deployment is configured to enforce —
    // silently, in the direction of green, at the one transition that cannot be taken back. A configured
    // dependency that cannot answer REFUSES the ship: an operator can retry a refusal and cannot un-ship a
    // release. (`fence` is bound once so the narrowing carries — the wiring is read here, not re-asked.)
    const fence = input.status === "released" ? this.deps.capabilityGenerations : undefined;
    const settingsRevision = fence
      ? await fenceRead("the workspace settings revision", record.id, () => fence.settingsRevision(tenant))
      : undefined;
    const topLevelRefs = ProductService.capabilityRefsFor(product, record);
    const contracts = await this.resolveContracts(tenant, product, record);
    // …and the NESTED documents those contracts named — a judge's model, its rubric, its delegated harness.
    // They cannot be enumerated before the resolution (that is what the resolution discovers), so they are
    // read after it, and the contract RE-VERIFY below is what covers the gap between the two: anything that
    // moved in between changes the contract digest, which refuses.
    const generations = fence
      ? await fenceRead("the capability generations", record.id, () =>
          fence.read(tenant, [...topLevelRefs, ...ProductService.nestedCapabilityRefs(contracts)]),
        )
      : undefined;
    const readiness = await this.readinessUnder(tenant, record, product, contracts);
    const transition = Release.from(record).setStatus(
      {
        to: input.status,
        openIssues: readiness.openIssues,
        regressedSeries: readiness.regressedSeries,
        // WHAT WENT OUT, as ledger rows rather than as strings somebody typed (arch-review 21 P1). Resolved
        // here because only this layer can read the version ledger, and resolved AT SHIP because that is the
        // moment the composition stops being a plan.
        ...(input.status === "released"
          ? { shippedComponents: await this.resolveShippedComponents(tenant, record) }
          : {}),
        // The ship-time evidence snapshot — the history entry records WHAT the gate saw (per-series
        // verdicts); the live readiness keeps moving after the decision.
        // The evidence this ship stood on — both sides with their scoring pins, so the decision is
        // reproducible and the NEXT release can anchor on this exact candidate instead of re-searching by
        // time (a post-ship re-score would otherwise change what "last time's baseline" means).
        seriesDecisions: readiness.series.map((s) => ({
          key: s.key,
          verdict: s.verdict,
          // The DOMAIN already decided this (arch-review 13) — `releaseReadiness` computes `required` per
          // series, including for a `scope_invalid` entry whose declaration no longer exists and which
          // re-deriving from `product.series` would silently read as required-by-absence. A downstream that
          // rebuilds a decision's meaning from the raw materials is the reconstruction this whole review
          // generation has been removing.
          required: s.required,
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
          // WHAT THIS SERIES WAS ASKED — from the same resolution the readiness evaluated, so the recorded
          // question and the evaluated question are one artifact rather than two lookups.
          ...(contracts?.get(s.key)?.status === "resolved"
            ? {
                evaluationContract: {
                  digest: (contracts.get(s.key) as { digest: string }).digest,
                  ...(contracts.get(s.key) as { contract: ResolvedSeriesContract }).contract,
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
    // THE FULL READ-SET this decision stood on (arch-review 22 P0-1). The product's policy and definition
    // were already conditions on the write; the issues and the candidate selection were not, so a decision
    // could commit stating `openIssues: 0` after an issue was linked, or ship against S10 after S11 landed.
    // A scoring pin says WHICH judgment was read; it cannot say "and it was still the latest".
    //
    // `scope_invalid` entries are excluded: a promised series whose declaration is gone has no watched
    // definition, so "no succeeded batch exists for it" is not a claim this decision made.
    //
    // …and the CAPABILITIES those contracts were resolved from, so a registration landing between the
    // decision and the commit is a condition on the write rather than something only the re-verify below can
    // notice. `asOf` is taken BEFORE the contracts resolve: anything registered from that instant on is a
    // document this decision did not read.
    const decision =
      input.status === "released"
        ? {
            openIssues: readiness.openIssues,
            // The candidate as an IDENTITY (arch-review 23 P0-1): which row, and which judgment OF that row.
            // The scoring pin comes from the gate's own reading where the gate ran — the same pin the ship
            // records — so the fence holds exactly what the decision stood on rather than a re-derivation.
            candidates: readiness.series
              .filter((entry) => entry.verdict !== "scope_invalid")
              .map((entry) => ({
                productId: product.id,
                seriesKey: entry.key,
                pin:
                  entry.latest === undefined
                    ? null
                    : {
                        scorecardId: entry.latest.scorecardId,
                        createdAt: entry.latest.createdAt,
                        ...(entry.latest.scoring !== undefined
                          ? {
                              scoringRevision: entry.latest.scoring.revision,
                              scorePlaneDigest: entry.latest.scoring.scorePlaneDigest,
                            }
                          : {}),
                      },
              })),
            // …each name with the generation it resolved under. Absent reader = no fence (the guard then holds
            // only what the other conditions cover), which is the same honest degradation every optional
            // store in this service has.
            ...(generations !== undefined
              ? {
                  capabilities: generations.map((g) => ({
                    kind: g.kind as "dataset" | "harness" | "judge" | "rubric" | "model",
                    id: g.id,
                    tenantGeneration: g.tenantGeneration,
                    sharedGeneration: g.sharedGeneration,
                  })),
                }
              : {}),
            ...(settingsRevision !== undefined ? { settingsRevision } : {}),
          }
        : undefined;
    // THE AMBIENT HALF of the read-set, which has no row to fence (arch-review 22 P0-1). Each series'
    // evaluation contract is resolved from REGISTRIES and workspace settings — a new `latest`, a
    // workspace-local document shadowing a `_shared` one, a changed default judge model — none of which
    // touch the product row the CAS conditions on. There is no generation token to compare inside the write
    // statement, so this is a RE-VERIFY rather than a CAS, and it is labelled as one: it closes the window
    // between the decision and the commit, and cannot close the one inside the commit itself. A registry
    // generation is what would make this a condition on the write; until then, saying which of the two this
    // is beats implying the stronger one.
    if (input.status === "released" && contracts !== undefined && contracts.size > 0) {
      const now = await this.resolveContracts(tenant, product, record);
      for (const [key, before] of contracts) {
        const after = now?.get(key);
        const digestOf = (r: SeriesContractResolution | undefined): string =>
          r === undefined ? "absent" : r.status === "resolved" ? r.digest : r.status;
        if (digestOf(before) !== digestOf(after))
          throw new ConflictError(
            "CONFLICT",
            { release: record.id, series: key },
            `the evaluation contract for series '${key}' changed while this ship was being decided — the readiness you saw was computed against a different question. Re-read the release and decide again.`,
          );
      }
    }
    // THE DIGEST OF THE READ-SET (arch-review 27), stamped onto the recorded decision. The conditions
    // themselves are enforced inside the write statement, where they belong; this is the cheap answer to
    // "what did this ship read", so two decisions can be told apart in history without re-deriving anything.
    const stamped =
      decision === undefined
        ? transition
        : {
            ...transition,
            patch: {
              ...transition.patch,
              history: transition.patch.history?.map((entry, i, all) =>
                i === all.length - 1 && entry.detail !== undefined
                  ? { ...entry, detail: { ...entry.detail, contextDigest: contentDigest(decision) } }
                  : entry,
              ),
            },
          };
    return this.applyReleaseTransition(record, stamped, product, decision);
  }

  async removeRelease(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const record = await this.getRelease(tenant, id);
    if (record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "releases:delete" },
        "You are not allowed to delete this release (creator or workspace admin only).",
      );
    // …and permission is not the only question. A RELEASED release is the historical anchor the next
    // release's baseline resolves from, so removing it does not fail that comparison — it makes it believe
    // nothing was ever shipped (arch-review 21 P0-3). The domain owns that legality.
    Release.from(record).assertRemovable();
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
    // The already-resolved contracts, when the caller froze them (the ship path). Absent = resolve here,
    // which is what a plain readiness READ does.
    contracts?: Map<string, SeriesContractResolution>,
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
    // WHAT EACH SERIES ASKS TODAY. Resolved once per readiness read, so the freshness check compares the
    // stamp a batch carries against the contract now in force rather than against the series' NAME.
    const contractBySeries = contracts ?? new Map<string, SeriesContractResolution>();
    if (contracts === undefined && this.deps.resolveSeriesContract !== undefined) {
      for (const series of resolveWatchedSeries(product, release).series) {
        // UNRESOLVABLE IS RECORDED, not dropped (arch-review 14 P0). Omitting the entry turned "we could not
        // resolve this series' current definition" into "skip the freshness check" — unknown becoming
        // absence becoming safe, in the one place that decides whether a release ships. The domain blocks a
        // required series on it; a thrown resolver is the same fact and says so.
        const resolution = await this.deps.resolveSeriesContract(tenant, series).catch(
          (err): SeriesContractResolution => ({
            status: "unresolvable",
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        contractBySeries.set(series.key, resolution);
      }
    }
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
          //
          // …with the SAME tie-break the write's fence uses (arch-review 25 P2). The guard asks "has anything
          // `(created_at, id) >` the pinned candidate landed", so a read that ordered on the timestamp alone
          // could pick a different row of a same-millisecond pair than the condition it then commits under —
          // the decision and its fence disagreeing about which one is latest. One ordering, both sides.
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
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
    return releaseReadiness(
      release,
      product,
      latestBySeries,
      baselineBySeries,
      gateBySeries,
      openIssues,
      contractBySeries,
    );
  }

  // Resolve every watched series' current contract ONCE. The ship path freezes this and reuses it for both
  // the evaluation and the recorded decision; a readiness read resolves inline.
  private async resolveContracts(
    tenant: string,
    product: ProductRecord,
    release: ReleaseRecord,
  ): Promise<Map<string, SeriesContractResolution> | undefined> {
    if (this.deps.resolveSeriesContract === undefined) return undefined;
    const out = new Map<string, SeriesContractResolution>();
    for (const series of resolveWatchedSeries(product, release).series) {
      out.set(
        series.key,
        await this.deps.resolveSeriesContract(tenant, series).catch(
          (err): SeriesContractResolution => ({
            status: "unresolvable",
            reason: err instanceof Error ? err.message : String(err),
          }),
        ),
      );
    }
    return out;
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
    // …and the REST of the decision's read-set (arch-review 22 P0-1): the issues it counted and the
    // candidate it compared per series. Passed only for the SHIP, because only the ship's legality is
    // computed from them — a cancel is legal whatever the evidence says, so fencing it on evidence would
    // refuse a decision nothing could invalidate.
    decision?: {
      openIssues: number;
      candidates: ReadonlyArray<{
        productId: string;
        seriesKey: string;
        pin: {
          scorecardId: string;
          createdAt: string;
          scoringRevision?: number;
          scorePlaneDigest?: string;
        } | null;
      }>;
      capabilities?: ReadonlyArray<{
        kind: "dataset" | "harness" | "judge" | "rubric" | "model";
        id: string;
        tenantGeneration: number | null;
        sharedGeneration: number | null;
      }>;
    },
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
        // …and the PRODUCT's POLICY must still be the one this decision read. A different aggregate, so the
        // release's own version cannot speak for it — and the product's row version cannot either: it bumps
        // on every write, including the sync sweep's watermark, so it conflicted ships whose policy had not
        // moved. The digest is the identity; the version rides along only as the legacy fallback for a
        // product written before the column existed (mig 0154).
        ...(product !== undefined
          ? {
              expectProduct: {
                id: product.id,
                version: product.version ?? 0,
                policyDigest: productReleasePolicyDigest(product),
                // …and WHAT ITS SERIES ASK (arch-review 15 P0-4). The ship resolved each series' contract
                // from this definition; an edit to it during the decision must invalidate the decision, and
                // the governance digest — narrowed on purpose — cannot see that.
                definitionDigest: productEvaluationDefinitionDigest(product),
              },
            }
          : {}),
        ...(decision !== undefined ? { expectDecision: decision } : {}),
      },
    );
    if (updated === undefined) {
      const live = await this.deps.releases.get(current.tenant, current.id);
      if (live !== undefined) {
        const liveProduct = product !== undefined ? await this.deps.store.get(current.tenant, product.id) : undefined;
        const policyMoved =
          product !== undefined &&
          liveProduct !== undefined &&
          productReleasePolicyDigest(liveProduct) !== productReleasePolicyDigest(product);
        const definitionMoved =
          product !== undefined &&
          liveProduct !== undefined &&
          productEvaluationDefinitionDigest(liveProduct) !== productEvaluationDefinitionDigest(product);
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
          definitionMoved
            ? "this product's series definition (dataset/harness/judges) was edited while the decision was being made — the evidence this readiness accepted answers a question the product no longer asks; re-read it and decide again."
            : policyMoved
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
    // WHICH QUESTION this batch answered — compared against what the series asks now.
    ...(record.origin?.seriesContractDigest !== undefined
      ? { contractDigest: record.origin.seriesContractDigest }
      : {}),
    ...(scoring ? { scoring } : {}),
    // WHICH WORLD it ran in (arch-review 19 P2) — carried so a comparison can say whether it stayed inside
    // one. Not part of the question the batch answered; part of the conditions under which it answered it.
    ...(record.world ? { world: record.world } : {}),
  };
}
