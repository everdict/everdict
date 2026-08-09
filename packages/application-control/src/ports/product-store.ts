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
  update(
    tenant: string,
    id: string,
    patch: Partial<ProductRecord>,
    events?: OutboxEvent[],
  ): Promise<ProductRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
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
    guard?: { expectStatus: ReleaseStatus },
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
