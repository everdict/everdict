import type { ConstitutionalPublisher } from "@everdict/application-control";
import { type Dataset, DatasetSchema } from "@everdict/contracts";
import { PgConstitutionApprovalStore, type SqlClient, withTransaction } from "@everdict/db";
import { PgDatasetRegistry } from "@everdict/registry";

// ONE COMMIT FOR THE WHOLE PUBLICATION (arch-review 25 P0-2).
//
// The dataset bytes live in the registry, the receipt lives beside them, and the two are written by adapters
// that do not know about each other — which is why this lives HERE. The composition root is the only layer
// that can see one connection underneath both, and cross-adapter atomicity is exactly what a composition root
// exists to arrange.
//
// The window it closes is small and the state inside it is not: bytes registered under a name whose recorded
// approval names DIFFERENT bytes. Submit compares the two, so such a dataset is refused forever — and the
// only way back, `legacy_attested`, records that it was authorised after it already ran, which is false. A
// publication that half-lands does not lose information; it writes a wrong history.
//
// The generation bump rides along for free: `PgVersionedStore` advances it inside the registry's own INSERT
// statement, and that statement is now inside this transaction — so bytes, receipt and capability generation
// become visible together or not at all.
export function pgConstitutionalPublisher(client: SqlClient): ConstitutionalPublisher {
  return {
    async publish(input) {
      // Parsed here rather than trusted from the caller: this function's whole claim is that the RECEIPT and
      // the BYTES agree, and it cannot make that claim about a shape it never validated.
      const dataset: Dataset = DatasetSchema.parse(input.dataset);
      await withTransaction(client, "publishing a dataset that declares ground_truth authority", async (tx) => {
        await new PgDatasetRegistry(tx).register(input.tenant, dataset, input.createdBy, input.origin as never);
        await new PgConstitutionApprovalStore(tx).record(input.tenant, input.approval);
      });
    },
  };
}
