import { PRODUCT_SERIES_LIMIT } from "@everdict/contracts";
import { z } from "zod";

// POST /products/:id/series/run — evaluate the product's watch series now.
//
// `keys` absent means "everything this product currently watches" (the same selection an import fans out to);
// naming keys runs exactly those. An empty ARRAY is refused rather than read as absent: "run these, and there
// are none" is a request nobody makes on purpose, and treating it as "run everything" would turn a bug in a
// caller into a batch storm on somebody's bill.
export const RunProductSeriesBodySchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(PRODUCT_SERIES_LIMIT).optional(),
});
