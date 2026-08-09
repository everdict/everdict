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
      expectProduct?: { id: string; version: number; policyDigest: string };
    },
  ): Promise<ReleaseRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}

export interface ProductVersionListFilter {
  productId: string;
  service?: string;
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
