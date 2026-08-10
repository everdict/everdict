import { z } from "zod";
import { JudgeIdSchema } from "../harness/judge-spec.js";
import { GateScoringPinSchema } from "./gate.js";
import { TrackerHistoryEntrySchema } from "./tracker.js";

// The PRODUCT TIMELINE — Product ⊃ Release, over a ledger of imported service versions
// (docs/architecture/product-timeline.md). The tracker answers "why we evaluate"; a Product answers "what we
// ship": the real services that compose the released thing, imported from GitHub releases/tags, and the trend
// series (dataset × harness × judges) whose scorecards tell whether the product got better between releases.
// A Release is the checkpoint on that axis — planned first, then released through a gate that refuses while
// linked issues are open or a watched series has regressed. Deliberately separate from Initiative: an
// initiative is a GOAL, a release is a DATE a specific composition of services went out on.

// Calendar dates, not instants — same rule as the tracker: "did we release by the 14th" is a date question,
// and the literal YYYY-MM-DD round-trips with no timezone reinterpretation.
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// --- Tracked services: the product's real composition ---
// A service here is NOT the harness's topology service (that is an execution spec): it is the repository whose
// releases/tags mark "this component moved" on the product's time axis. GitHub is the source of record and
// everdict stays the client — versions arrive by pull (a member presses Sync, later a sweep), never by webhook,
// the same stance the GitHub issue sync takes.
export const PRODUCT_SERVICE_SOURCES = ["releases", "tags"] as const;
export const ProductServiceSourceSchema = z.enum(PRODUCT_SERVICE_SOURCES);
export type ProductServiceSource = z.infer<typeof ProductServiceSourceSchema>;

// Sync state per service — a REMOTE clock reading (the newest publishedAt successfully imported), so clock skew
// between the control plane and GitHub can never make us skip a version. Absent = never synced, and the first
// sync is a BACKFILL: it fills the timeline's past but never fires the auto-eval (a storm of runs for old
// versions is exactly what the watermark exists to prevent).
export const ProductServiceSyncSchema = z.object({
  syncedAt: z.string().optional(),
  lastError: z
    .object({
      at: z.string(),
      message: z.string(),
    })
    .optional(),
  // WHETHER THIS SERVICE'S HISTORY WAS FULLY OBSERVED (arch-review 17 P1-6). A read that hits its page
  // ceiling imports the newest pages and reports `incomplete` in the sync RESPONSE — which the person who
  // pressed Sync can see, and which a background sweep, a later reader or an owner-agent cannot recover
  // afterwards: the durable row just said "synced". That is not a false green, it is a loss of operational
  // truth about a system of record, and the two are only one inference apart.
  //
  // `partial` is the fact, `partialAt` is when it was observed. Absent = never observed as partial (a legacy
  // row, or a stream that has only ever read completely) — which is honestly UNKNOWN for the legacy case, and
  // is why the field records the positive observation rather than a "complete" claim nobody made.
  completeness: z.enum(["complete", "partial"]).optional(),
  partialAt: z.string().optional(),
  // THE NEWEST REMOTE PUBLICATION THIS SERVICE HAS EVER OBSERVED (arch-review 19 P1).
  //
  // `syncedAt` is this control plane's clock at the last sweep — useful for "when did we last look", useless
  // for "what had we already seen". Those are different questions, and the second one is what separates news
  // from history: after a page-ceiling read imports v100..v50 and an operator raises the ceiling, v49..v1 are
  // NEW ROWS to the ledger and OLD FACTS about the world. Treating them as arrivals fires an evaluation wave
  // for releases that shipped years ago and writes a causal story that never happened.
  //
  // A release carries its own publication instant, so the boundary is exact: `publishedAt > observedRemoteHead`
  // is news, anything at or below it is recovered history. Absent = never recorded (a legacy row, or a stream
  // that has only ever read completely), in which case the backfill discriminator remains the only signal —
  // honestly, since inventing a head would be claiming an observation nobody made.
  observedRemoteHead: z.string().optional(),
});
export type ProductServiceSync = z.infer<typeof ProductServiceSyncSchema>;

export const ProductServiceSchema = z.object({
  // Unique within the product (the service refuses duplicates) — this is the name the timeline and the version
  // ledger key on, so renaming it orphans the service's imported history on purpose (it is a new track).
  name: z.string().min(1).max(100),
  // Unset = github.com; set = the deployment's GitHub Enterprise host (same convention as WorkspaceCiLink).
  host: z.string().optional(),
  repository: z.string().min(1), // "owner/name"
  source: ProductServiceSourceSchema,
  // Only tags starting with this prefix belong to the service — a monorepo releases several services from one
  // repository ("api-v1.2.0" vs "web-v3.1.0"), and without the filter every service would claim every tag.
  tagPrefix: z.string().max(100).optional(),
  // WHERE the service lives inside the repository ("apps/api", "packages/core") — a monorepo composes one
  // product out of several subpaths, and this is what lets a reader walk from a timeline row back to the code.
  //
  // DELIBERATELY NOT part of `serviceStreamKey`. What a service READS is (host, repository, source, tagPrefix);
  // the path says where its code sits. Two services under one repo-wide tag stream genuinely move together —
  // folding the path into the stream identity would declare one stream to be two, and would reset an import
  // watermark for an edit that changed nothing about what is read. Composition, not provenance.
  path: z.string().max(200).optional(),
  sync: ProductServiceSyncSchema.optional(),
});
export type ProductService = z.infer<typeof ProductServiceSchema>;

// --- Watch series: the trends the product is judged by ---
// One series = one question asked repeatedly ("agent quality on the support dataset, judged by helpfulness").
// The KEY is the series' durable identity: scorecards stamp it in their origin, so the trend survives renaming
// the label, and deleting a series stops future runs without unkeying the history already recorded.
const SeriesCapabilityRefSchema = z.object({
  id: z.string().min(1),
  // Absent = "latest at run time" — which is what a standing series means: the harness keeps evolving (CI
  // re-pins mint new instance versions) and the series evaluates whatever is current. Pinning is the exception.
  version: z.string().optional(),
});

export const ProductSeriesSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Series keys are lowercase slugs (a-z, 0-9, -)."),
  label: z.string().min(1).max(200),
  dataset: SeriesCapabilityRefSchema,
  harness: SeriesCapabilityRefSchema,
  // UNIQUE BY ID, not by (id, version) — arch-review 16 P1-7. A judge OWNS a metric family (`judge:<id>` plus
  // its criterion children) and the scoring stage's natural key is (case, judgeId), so two versions of one
  // judge in a single selection is a state the plane below cannot represent: they would write the same metric
  // family and claim the same stage row, and a Postgres upsert whose statement carries the conflict key twice
  // fails outright. A structurally impossible selection has to be refused where it is declared, not
  // discovered at judging time on the provider's bill.
  judges: z
    .array(SeriesCapabilityRefSchema.extend({ id: JudgeIdSchema }))
    .default([])
    .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, {
      message:
        "A series may name each judge once — a judge owns one metric family, so two versions of it cannot both score a case.",
    }),
  // Whether this series GATES a release (arch-review 7 P0). Absent = TRUE — fail closed: a series someone
  // declared worth watching blocks a ship until it is evaluated and passes. Opting a series out of the gate
  // is an EXPLICIT product choice recorded here, never something inferred from the absence of evidence
  // ("it never ran, so it cannot have regressed" is exactly the false green this field exists to kill).
  requiredForRelease: z.boolean().optional(),
  // Ship this series' FIRST evaluation without a comparison. Explicit, per series, and recorded in the
  // release decision — a bootstrap is a governance call, not an inference from missing history.
  allowNoBaseline: z.boolean().optional(),
});
export type ProductSeries = z.infer<typeof ProductSeriesSchema>;

// How many series a product may declare — enough for "the axes we actually watch", small enough that a version
// import cannot fan out into an unbounded batch storm.
export const PRODUCT_SERIES_LIMIT = 20;

// Auto-eval: a newly imported service version submits one scorecard per watched series (the active planned
// release's selection, else every series). Enabled by default because it is the product timeline's point;
// the backfill rule above keeps the default safe.
export const ProductAutoEvalSchema = z.object({
  enabled: z.boolean(),
  // Placement override for the submitted batches (a RuntimeSpec name). Absent = the submitter's default.
  runtime: z.string().optional(),
});
export type ProductAutoEval = z.infer<typeof ProductAutoEvalSchema>;

export const ProductRecordSchema = z.object({
  // Aggregate version (mig 0150) — bumped on every write, and the token a RELEASE decision commits against.
  // A release gate is evaluated under this product's series policy (which series gate, which pre-approve a
  // bootstrap) but lives in a different aggregate, so the release's own version could not protect it: an
  // admin flipping a series to required mid-decision left the release row untouched, the guard passed, and
  // a decision made under the old policy was recorded as standing on the new one. Absent on pre-migration
  // rows (read as 0).
  version: z.number().int().nonnegative().optional(),
  // The identity of this product's RELEASE POLICY — a content digest of every series'
  // {key, required, allowNoBaseline}, maintained by the store on write (mig 0154). A ship decision commits
  // against THIS rather than against `version`, because the version bumps on every write, including the
  // 15-minute sync sweep's watermark — so it made a background write conflict a ship whose policy had not
  // moved. Derived, never author-supplied. Absent on rows written before the column existed; the release
  // guard then falls back to the version, which is sound and merely over-broad.
  releasePolicyDigest: z.string().optional(),
  // The identity of what this product's series ASK — dataset/harness/judge refs as declared (mig 0160). A
  // companion to the policy digest above, deliberately NOT folded into it: the policy digest was narrowed to
  // governance so a rename stops conflicting an in-flight ship, and a ship also stands on the definition,
  // which that narrowing left unguarded. Two questions, two digests. Derived by the store on write.
  evaluationDefinitionDigest: z.string().optional(),
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  // One emoji — same affordance (and same reasoning) as an initiative's icon.
  icon: z.string().max(8).optional(),
  services: z.array(ProductServiceSchema).default([]),
  series: z.array(ProductSeriesSchema).default([]),
  autoEval: ProductAutoEvalSchema.default({ enabled: true }),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductRecord = z.infer<typeof ProductRecordSchema>;

// --- Release: a checkpoint on the product's axis ---
// `planned` is where a release starts — a date and a scope somebody committed to. Moving to `released` is a
// GATE (the domain refuses while linked issues are open or a watched series regressed; `force` is recorded),
// because "we shipped" with open regressions should be a deliberate override, never a default.
// WHICH COMPOSITION this release ships — one row per tracked service, naming the version that goes out. The
// product declares WHAT composes it; the release says WHICH versions of that composition shipped together,
// which is the question a monorepo product cannot answer from the version ledger alone (three services move
// on their own streams, and "these three went out as 2026.3" is a decision somebody makes, not a fact the
// ledger derives).
//
// `version` is OPTIONAL on purpose: a planned release legitimately names a service whose version is not cut
// yet. "We have not decided" and "v1.2.3" are different statements, and defaulting the hole to the newest
// import would put a version into the plan that nobody chose. The picker fills it from the ledger at ship
// time; the ship then freezes the resolved composition into the release's history entry.
export const ReleaseComponentSchema = z.object({
  service: z.string().min(1), // ProductService.name — the timeline's key, validated against the product
  version: z.string().min(1).optional(),
  // WHICH ledger row this component means (arch-review 22 P1). `{service, version}` does not uniquely name
  // one: a service repointed at another repository tracks a different stream under the same name, and both
  // streams can publish `v1.0.0`. The picker knows which row it offered, so it says so — and a resolution
  // that had to GUESS between two rows is manufacturing history, not refining it.
  versionRecordId: z.string().optional(),
});
export type ReleaseComponent = z.infer<typeof ReleaseComponentSchema>;

// WHAT ACTUALLY WENT OUT — the plan RESOLVED against the version ledger at ship time (arch-review 21 P1).
//
// `{service, version}` stopped being sufficient historical identity the moment the ledger became
// stream-aware: a service repointed from repo-A to repo-B tracks a different stream under the same name, and
// both streams can publish `v1.0.0`. A frozen plan row therefore cannot answer "which v1.0.0 did 2026.3
// ship?" — the exact question a release exists to answer later. The ship resolves the row and freezes its
// identity; the UI's picker enforced this and the API did not, so any REST/MCP caller could write an
// arbitrary string into a shipped composition.
//
// `resolution` is explicit rather than inferred from absence: a release may legitimately ship with a
// component whose version was never decided, and "we did not decide" must not read the same as "we could not
// find it in the ledger".
export const ShippedComponentSchema = z.object({
  service: z.string().min(1),
  version: z.string().min(1).optional(),
  versionRecordId: z.string().optional(), // the ledger row this component IS
  streamKey: z.string().optional(), // …and which stream that row came from
  // `ambiguous` is its own answer, not a flavour of `unresolved` (arch-review 22 P1): "we could not find it"
  // and "we found two and the plan does not say which" are completely different facts in a post-mortem, and
  // only one of them is fixed by importing more versions.
  resolution: z.enum(["ledger", "unresolved", "unplanned", "ambiguous"]),
});
export type ShippedComponent = z.infer<typeof ShippedComponentSchema>;

export const RELEASE_STATUSES = ["planned", "released", "cancelled"] as const;
export const ReleaseStatusSchema = z.enum(RELEASE_STATUSES);
export type ReleaseStatus = z.infer<typeof ReleaseStatusSchema>;

export const ReleaseRecordSchema = z.object({
  // Aggregate version (mig 0148) — the optimistic-concurrency token a ship decision commits against. A
  // release stays EDITABLE while planned, so guarding only on status let a decision made over one watched
  // set commit onto a record whose set had changed underneath it. Absent on pre-migration rows (read as 0).
  version: z.number().int().nonnegative().optional(),
  id: z.string(),
  tenant: z.string(),
  productId: z.string(),
  name: z.string().min(1).max(200), // "2026.3", "v1.4.0" — the product's own naming, not a tag
  description: z.string().optional(),
  status: ReleaseStatusSchema,
  targetDate: CalendarDateSchema.optional(),
  releasedAt: z.string().optional(),
  // Which of the product's series this release watches. Absent = every series — the common case; a subset is
  // "this release is judged on these axes", and the gate + the readiness read honor exactly that selection.
  seriesKeys: z.array(z.string()).optional(),
  // The scope this release COMMITTED TO when it was planned (arch-review 12 P0). A release is "a date and a
  // scope somebody committed to", and the scope was being re-derived from the product's CURRENT series on
  // every read — so deleting a series did not fail the gate, it DELETED the gate: `seriesKeys: ["quality"]`
  // filtered against a product with no `quality` produced an empty watch list, no blocking series, and
  // `ready: true`. That is a bypass underneath every invariant above it, and the product's version CAS
  // cannot see it: the decision reads the NEW product correctly, and the new product is the one missing its
  // gate.
  //
  // Frozen at plan time, for BOTH selection modes. An explicit selection freezes what it named; `all`
  // freezes what "all" meant that day. A series ADDED later is still watched under `all` (more gates is
  // never the unsafe direction); a promised series that DISAPPEARS is `scope_invalid` and blocks.
  // Absent on releases planned before this existed — those fall back to the live derivation, which is the
  // honest degradation for a promise nobody recorded.
  plannedSeriesKeys: z.array(z.string()).optional(),
  // How the scope was chosen, so a reader can tell "watch everything" from "watch exactly these" after the
  // fact — the two behave differently when the product gains a series.
  seriesSelection: z.enum(["all", "explicit"]).optional(),
  // The service versions this release ships (mig 0162). Absent = the composition was never declared, which
  // is a different fact from an empty list ("this release ships no tracked service") and reads that way.
  // Deliberately NOT a gate input: the gate decides on evidence (open issues, series verdicts), and making a
  // half-filled plan un-shippable would be a second, weaker release constitution beside the one that already
  // exists. It is the RECORD of what went out — frozen into the ship's history entry, drawn on the axis.
  components: z.array(ReleaseComponentSchema).optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReleaseRecord = z.infer<typeof ReleaseRecordSchema>;

// --- The imported version ledger (append-only) ---
// One row per (service, version) — the fact that a component moved, stamped with the remote's own publishedAt.
// Idempotent by that natural key: a re-sync can never duplicate a version, and therefore can never re-fire the
// auto-eval for one. Facts only: `prerelease` is GitHub's own flag, `notes` is the release body's first lines.
export const PRODUCT_VERSION_KINDS = ["release", "tag"] as const;
export const ProductVersionKindSchema = z.enum(PRODUCT_VERSION_KINDS);
export type ProductVersionKind = z.infer<typeof ProductVersionKindSchema>;

export const PRODUCT_VERSION_NOTES_LIMIT = 2000;

export const ProductServiceVersionRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  productId: z.string(),
  service: z.string(), // ProductService.name — what people call it
  // WHICH STREAM this version came from (mig 0155) — `serviceStreamKey`: repository, source, host, tagPrefix.
  // The name is not the identity: repointing a service at a different repository means the name now tracks a
  // different stream, which is exactly why the domain clears its sync watermark. Keying the ledger on the
  // name alone made repo-B's v1.0.0 collide with repo-A's already-imported v1.0.0 and vanish as "known" — a
  // genuinely new release that could never become news. Absent on rows written before the column existed;
  // the writer ADOPTS those into the stream their service currently points at rather than re-importing them.
  streamKey: z.string().optional(),
  version: z.string().min(1), // the tag name, verbatim (no prefix stripping — the record keeps the fact)
  kind: ProductVersionKindSchema,
  prerelease: z.boolean().default(false),
  sha: z.string().optional(),
  url: z.string().optional(),
  notes: z.string().max(PRODUCT_VERSION_NOTES_LIMIT).optional(),
  publishedAt: z.string(), // the REMOTE clock — ordering on the timeline uses this, not our import time
  importedAt: z.string(),
});
export type ProductServiceVersionRecord = z.infer<typeof ProductServiceVersionRecordSchema>;

// --- Derived readiness (computed on detail reads, never stored) ---
// Same treatment as the tracker's rollups: the gate's verdicts are cheap, always-fresh reads over what the
// caller already fetched — a stored flag would be a cache to invalidate on every scorecard completion.
// (The SHIP itself snapshots the per-series verdicts into the release's history entry — the decision is
// recorded; the live read never is.)

// A series' RELEASE VERDICT (arch-review 7 P0) — the SCORECARD GATE's own vocabulary, not a second truth:
// pass|block|blocked_missing|not_comparable come verbatim from evaluateGate over (baseline, latest); the
// product layer adds only its two orchestration states: `not_evaluated` (no succeeded run for the series —
// which BLOCKS a required series: not evaluated is never green) and `no_baseline` (evidence exists but no
// prior ship anchors a comparison — the first ship's informational pass; there is nothing to regress FROM).
export const SeriesVerdictSchema = z.enum([
  "pass",
  "no_baseline",
  // A required series' FIRST ship: evidence exists but nothing anchors a regression question. Blocking by
  // default (arch-review 8 P1) — "no comparison is possible" and "shipping is fine" are different sentences,
  // and the old conflation let a batch with zero verdicts ship green. Cleared by the series policy's
  // `allowNoBaseline`, which is what makes the first ship a recorded decision instead of a silent default.
  "bootstrap_required",
  "block",
  "blocked_missing",
  "not_comparable",
  "not_evaluated",
  // A series this release PROMISED to watch no longer exists on the product (arch-review 12 P0). Not a
  // measurement outcome at all — the gate itself is gone. It gets its own verdict because every other value
  // here describes evidence, and describing a deleted gate as "not evaluated" would file a configuration
  // fault as a measurement fact. ALWAYS blocking: deleting a series must never be a way to turn a red
  // release green, which is what silently filtering it out of the watch list amounted to.
  "scope_invalid",
  // Evidence exists for this series, but it was produced under a DIFFERENT evaluation contract than the one
  // the series declares now (arch-review 13 P0) — a changed dataset, harness or judge selection, or a
  // version-less ref whose `latest` moved. Not a measurement outcome: the question changed, so the answer is
  // an answer to a different question. Blocking for a required series, exactly like never having run.
  "contract_stale",
  // The series' CURRENT contract could not be resolved at all — a deleted dataset, a registry outage
  // (arch-review 14 P0). Distinct from `contract_stale`, which means "we know what the question is now and
  // this evidence answered a different one": here we do not know what the question is. Blocking for a
  // required series, because "we could not check" has never been a synonym for "it holds".
  "contract_unverifiable",
]);
export type SeriesVerdict = z.infer<typeof SeriesVerdictSchema>;

export const ReleaseSeriesStateSchema = z.object({
  key: z.string(),
  label: z.string(),
  // The newest succeeded scorecard stamped with this series, and the one anchoring the comparison — absent when
  // the series has not run yet (which is a real state the readiness card must show, not an error).
  latest: z
    .object({
      scorecardId: z.string(),
      passRate: z.number().optional(),
      createdAt: z.string(),
      serviceVersion: z.string().optional(),
      // WHICH judgment of that scorecard (arch-review 8 P1) — an id is not an evidence reference once a
      // re-score can change what the id means.
      scoring: GateScoringPinSchema.optional(),
    })
    .optional(),
  baseline: z
    .object({
      scorecardId: z.string(),
      passRate: z.number().optional(),
      createdAt: z.string(),
      scoring: GateScoringPinSchema.optional(),
    })
    .optional(),
  verdict: SeriesVerdictSchema,
  // Whether this series GATED the decision. Recorded because product policy is editable: a release decided
  // while `requiredForRelease` was false reads identically afterwards to one decided while it was true,
  // and "was this series required when we shipped?" is not answerable from a live re-read.
  required: z.boolean().optional(),
  // The gate's refusal details when the verdict is not a pass — verbatim GateReason.detail strings, so the
  // release card can say WHY without re-deriving the comparison.
  reasons: z.array(z.string()).optional(),
  // The two sides of this comparison ran in DIFFERENT execution worlds (arch-review 19 P2). Not a refusal —
  // the world is a comparison axis, not part of the evaluation contract, and blocking on it would make every
  // infrastructure move un-shippable until each baseline is re-run. It is the sentence that stops a
  // regression and a migration from being indistinguishable in the record afterwards.
  crossWorld: z.string().optional(),
  // Does this series BLOCK the release? true iff it is required (requiredForRelease !== false) and its
  // verdict is neither pass nor no_baseline. Kept as the boolean the ship gate and history always read —
  // pre-verdict rows called it "regressed", and the old meaning (a bare pass-rate drop) is exactly the
  // weaker-second-gate semantics this field no longer carries.
  regressed: z.boolean(),
});
export type ReleaseSeriesState = z.infer<typeof ReleaseSeriesStateSchema>;

export const ReleaseReadinessSchema = z.object({
  openIssues: z.number().int().nonnegative(),
  series: z.array(ReleaseSeriesStateSchema),
  // The keys of every series BLOCKING the ship (required && verdict ∉ {pass, no_baseline}) — the gate's
  // refusal names them. The field name predates the verdict vocabulary; its content is the blocking set.
  regressedSeries: z.array(z.string()),
  ready: z.boolean(), // openIssues === 0 && regressedSeries.length === 0
});
export type ReleaseReadiness = z.infer<typeof ReleaseReadinessSchema>;
