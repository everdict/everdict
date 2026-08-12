import type { ProductRecord, ProductServiceVersionRecord, ReleaseRecord, ReleaseStatus } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

// The product timeline's stores (docs/architecture/product-timeline.md). `events` is the E0 outbox — the same
// contract the tracker stores hold, because these aggregates are ours and their transitions are the state change.

export interface ProductListFilter {
  limit?: number;
}

export interface ProductStore {
  create(record: ProductRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<ProductRecord | undefined>;
  // The product's OTHER index (mig 0169): a slug is how the URL addresses it, so the read path has to be able
  // to start from one. Unique within the tenant — that is what makes it an address rather than a label.
  getBySlug(tenant: string, slug: string): Promise<ProductRecord | undefined>;
  list(tenant: string, filter?: ProductListFilter): Promise<ProductRecord[]>;
  // The background sync sweep's read — deployment-wide, every tenant's products in one pass (the same
  // standing platformEventService.listAll has: an internal reconcile loop is not acting for anyone).
  listAll(limit?: number): Promise<ProductRecord[]>;
  // `expectVersion` closes the aggregate's OWN lost update (arch-review 11 P1). The update is a whole-row
  // rewrite of a record the caller read, so two concurrent edits from the same snapshot silently drop one:
  // A changes `series`, B changes `description`, B's write carries A's stale `series` and reverts it. The
  // version incrementing twice proves both writes happened; it does not make both survive. This matters
  // more here than for an ordinary record because the product's `series` IS the release constitution — a
  // silently reverted `requiredForRelease` re-opens a gate somebody deliberately closed.
  //
  // A miss returns undefined exactly like a missing id; the caller just read the record, so undefined-under-
  // guard IS the conflict signal.
  update(
    tenant: string,
    id: string,
    patch: Partial<ProductRecord>,
    events?: OutboxEvent[],
    guard?: { expectVersion?: number },
  ): Promise<ProductRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
  // Delete the product AND everything that exists only underneath it, ATOMICALLY (arch-review 12 P1). The
  // schema deliberately has no foreign keys — "dangling state is the service's job" — and the service was
  // doing it by walking: list releases, delete each, delete versions, delete the product. Across replicas
  // that walk has a gap in the middle: a `createRelease` reading the product between the list and the final
  // delete inserts a release under a product that is about to stop existing, and nothing ever collects it.
  //
  // Choosing no-FK means the aggregate boundary has to be enforced by a transaction somewhere; imitating a
  // cascade from application code is where that obligation was quietly dropped. Returns what it removed so a
  // caller can report it rather than guess.
  removeAggregate(tenant: string, id: string): Promise<{ releases: number; versions: number }>;
}

export interface ReleaseListFilter {
  productId?: string;
  status?: ReleaseStatus;
  limit?: number;
}

export interface ReleaseStore {
  create(record: ReleaseRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<ReleaseRecord | undefined>;
  list(tenant: string, filter?: ReleaseListFilter): Promise<ReleaseRecord[]>;
  // `guard`: commit only from the status the caller read (arch-review 8 P1). A release is a terminal trust
  // claim, and its aggregate law ("released is history — no reopening") was enforced in the domain over a
  // record that had already been read: two replicas could both read `planned`, one legally decide `released`
  // and the other `cancelled`, and the last write to land would win. The outbox then carried a `released`
  // fact while the row said `cancelled` — a contradiction between what the platform announced and what it
  // holds. A guard miss returns undefined, exactly like a missing id.
  update(
    tenant: string,
    id: string,
    patch: Partial<ReleaseRecord>,
    events?: OutboxEvent[],
    // `expectVersion` is the real guard (arch-review 9 P0): a release stays EDITABLE while planned, so a
    // status-only CAS let a decision evaluated over one watched series set commit onto a record whose set had
    // been changed by a concurrent edit — status was still `planned`, the guard passed, and the shipped
    // record watched a series its readiness never looked at. `expectStatus` stays for callers that only care
    // about the lifecycle transition.
    // `expectProduct` is the CROSS-AGGREGATE half (arch-review 10 P0). A ship decision is evaluated under the
    // PRODUCT's series policy — which series gate, which pre-approve a bootstrap — and that policy is a
    // different row, so no amount of guarding on the release could see it move. Evaluated inside the write
    // statement (an EXISTS over the product row), the same shape as the scoring fence: a guard that reads
    // the other row first is not a guard, it is a wider window.
    guard?: {
      expectStatus?: ReleaseStatus;
      expectVersion?: number;
      // WHICH POLICY the decision stood on (mig 0154). `policyDigest` is the precise identity — a content
      // digest of every series' {key, required, allowNoBaseline} — and `version` is the LEGACY fallback the
      // store uses only while a product predates the column. The version alone conflated content, policy and
      // sync-watermark revisions in one counter, so a background sweep could conflict a ship its policy had
      // nothing to do with.
      // BOTH digests (mig 0154 + 0160): the governance policy AND the evaluation definition a decision stood
      // on. The policy digest was narrowed to governance so a rename stops conflicting a ship, which left
      // "which dataset/harness/judges does this series ask" unguarded — and a ship resolves exactly that.
      // `version` remains the legacy fallback for a product written before either column existed.
      expectProduct?: { id: string; version: number; policyDigest: string; definitionDigest: string };
      // THE REST OF THE DECISION'S READ-SET (arch-review 22 P0-1).
      //
      // A terminal release transition must CAS the full set of mutable state its decision was computed from,
      // not the convenient subset that happens to live on two rows. Readiness reads three things: the open
      // issues linked to this release, the newest succeeded scorecard per watched series, and the series'
      // current evaluation contracts. Only the last of those has no row to fence — the first two do, in the
      // same database, so a decision that shipped "0 open issues, no newer candidate" can be made to mean it
      // at the linearization point rather than at the moment somebody read it.
      //
      // Without this the record is not merely racy, it is WRONG in its own words: the history entry states
      // `openIssues: 0, force: false` while an open issue existed before the ship committed.
      expectDecision?: ReleaseDecisionContext;
    },
  ): Promise<ReleaseRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}

// THE READ-SET A RELEASE DECISION WAS COMPUTED FROM — one artifact, named, so the thing the service READ and
// the thing the write CONDITIONS ON cannot drift apart (arch-review 27).
//
// It used to be an anonymous shape declared inline on the guard and repeated in the Pg store, which meant a
// new member of the read-set had to be remembered in four places: the service's read, the recorded decision,
// the store's guard contract, and the SQL WHERE. Three of those failing silently is what every review in this
// series has been finding, one member at a time. The type is now one declaration, and the Pg guard builds its
// clauses from a map keyed by `keyof ReleaseDecisionContext` — so a member nobody wired does not compile.
//
// The rule this encodes: what a decision read is automatically what its commit conditions on.
export interface ReleaseDecisionContext {
  // How many OPEN issues were linked to this release when readiness ran.
  openIssues: number;
  // Per watched series, the candidate the decision compared — as an IDENTITY, not as a timestamp
  // (arch-review 23 P0-1).
  //
  // "Which row was latest" and "which judgment of that row did we read" are one candidate identity. A
  // `created_at >` predicate answers neither on its own: a RE-SCORE of the same scorecard leaves the
  // timestamp untouched while replacing the judgment the gate read, a live pass can be mid-flight over
  // it, the row can be deleted outright, and a new row landing in the same millisecond is not `>`
  // anything. Each of those is a decision made about evidence that is no longer what it was.
  //
  // `pin: null` means the decision saw NO evidence for that series — itself a decision input, since a
  // required series with no run blocks and one that gains a run afterwards was not the thing evaluated.
  candidates: ReadonlyArray<{
    productId: string;
    seriesKey: string;
    pin: {
      scorecardId: string;
      createdAt: string;
      // The judgment, from the scoring ledger. Absent on a batch settled before the ledger existed —
      // the identity then rests on the row and its recency, which is what those records can support.
      scoringRevision?: number;
      scorePlaneDigest?: string;
    } | null;
  }>;
  // …AND THE AMBIENT HALF, as far as a row can carry it (arch-review 22, second pass). A series'
  // evaluation contract resolves from the capability registries: a new version that `latest` moves to,
  // or a workspace-local document shadowing a `_shared` one, both arrive as INSERTS in a table this
  // database owns. Those are conditions the write can hold.
  //
  // What a row cannot carry is a SOFT DELETE (no insert) or a settings edit — those stay covered by
  // the service's re-verify, whose window is decision→commit rather than zero. Saying which half is
  // which beats one guard that implies it covers both.
  // …each name with the MUTATION GENERATION it resolved under (arch-review 23 P0-2). `created_at` was
  // the first attempt and it only ever saw an INSERT: a revive (`deleted_at = NULL`) and a soft delete
  // both change what a name answers while leaving every timestamp where it was, so a workspace-local
  // document could come back to life under a `_shared` name mid-decision and the fence saw nothing.
  // Historical time does not establish mutation authority.
  capabilities?: ReadonlyArray<{
    kind: "dataset" | "harness" | "judge" | "rubric" | "model";
    id: string;
    // TWO independent counters, carried apart (arch-review 24 P0-2). Owner-first resolution means either
    // namespace can change what a name answers, and they advance on their own clocks — so reducing them
    // to one number (a MAX) is not a fencing token, it is a PROJECTION. With `_shared` at 100 and the
    // tenant at 3, a local mutation to 4 leaves the maximum at 100 and the guard sees a world that did
    // not move — precisely the shadow this fence exists for.
    //
    // `null` = that namespace had no row when the decision read it, which the fence holds as "still
    // none": a first mutation creates one, and its appearance is the change.
    tenantGeneration: number | null;
    sharedGeneration: number | null;
  }>;
  // The workspace SETTINGS revision the contracts resolved under (mig 0164). The default judge model
  // is part of a series' contract identity — an identical judge list judged by a different model is a
  // different judging apparatus — and the settings are a row in this database like everything else the
  // ship conditions on, so there was never a reason for this half to be re-verify-only.
  settingsRevision?: number | null;
}

// THE RESOLUTION GENERATION of a capability NAME (mig 0163) — read before a decision resolves its contracts,
// held as a condition on the decision's commit. Its own port because it is not a product concern: it answers
// "has anything changed what this name resolves to", and the release decision is simply its first consumer.
export interface CapabilityGenerationStore {
  // The workspace settings row's mutation counter — `null` when the workspace has no settings row at all,
  // which is a real answer the fence holds as "still none".
  settingsRevision(workspace: string): Promise<number | null>;
  // Missing name = `null`, which is a real answer: nothing has ever mutated it under this fence.
  read(
    tenant: string,
    refs: ReadonlyArray<{ kind: string; id: string }>,
  ): Promise<Array<{ kind: string; id: string; tenantGeneration: number | null; sharedGeneration: number | null }>>;
}

export interface ProductVersionListFilter {
  productId: string;
  service?: string;
  // WHICH STREAM (arch-review 14 P1). The store became stream-aware in mig 0155 and the sync planner stayed
  // name-aware, which broke it in both directions: `known` collected repo-A's versions, so repo-B's v1.0.0
  // never reached the store to be recognised as a new stream's row at all; and the backfill probe saw
  // repo-A's rows, so repo-B's genuinely historical releases were announced as news. Identity has to be the
  // same all the way through, or the layer that resolves it last decides.
  streamKey?: string;
  limit?: number;
}

// The imported version ledger — append-only, idempotent by the natural key (tenant, productId, service,
// version). `create` returns whether the row was actually inserted: "is this version NEW" is the auto-eval's
// question, and the outbox events ride ONLY an actual insert (a known version can never be news twice — that
// invariant lives in the store so racing syncs cannot break it).
export interface ProductVersionStore {
  create(record: ProductServiceVersionRecord, events?: OutboxEvent[]): Promise<boolean>;
  list(tenant: string, filter: ProductVersionListFilter): Promise<ProductServiceVersionRecord[]>;
  removeForProduct(tenant: string, productId: string): Promise<void>;
}
