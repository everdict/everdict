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
  update(
    tenant: string,
    id: string,
    patch: Partial<ReleaseRecord>,
    events?: OutboxEvent[],
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
