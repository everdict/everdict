import { type ProductRecord, isProductSlugRef } from "@everdict/contracts";
import type { ProductStore } from "../ports/product-store.js";

// HOW A PRODUCT IS FOUND FROM A URL SEGMENT — one function, because it is one rule (mig 0169).
//
// A product answers to two names: its SLUG (what a URL carries, so a link reads as the thing people name in
// conversation) and its ID (what every stored pointer carries). Two collaborators need to start from a ref —
// `ProductService` for every read and write, `ProductVersionSync` for `POST /products/:id/sync` — and a rule
// implemented twice is a rule that drifts: the sync would have kept resolving ids only, so the one address the
// screen shows would have been the one address Sync refused.
//
// The discriminator is the ID's shape, not the slug's. A stored slug this deployment's minting rule would no
// longer produce (a backfilled row, a locale whose lowercasing Postgres and V8 read differently) must still
// RESOLVE — validation belongs where an address is created, and a read that revalidates it can only turn an
// addressable record into a 404. The id fallback is what keeps every link minted before the column existed
// working.
export async function findProductByRef(
  store: ProductStore,
  tenant: string,
  ref: string,
): Promise<ProductRecord | undefined> {
  if (!isProductSlugRef(ref)) return store.get(tenant, ref);
  return (await store.getBySlug(tenant, ref)) ?? (await store.get(tenant, ref));
}
