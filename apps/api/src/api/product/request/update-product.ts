import { PRODUCT_SERIES_LIMIT, ProductAutoEvalSchema, ProductSeriesSchema } from "@everdict/contracts";
import { z } from "zod";
import { ProductServiceBodySchema } from "./create-product.js";

// Lists REPLACE what is there (the tracker's member-list rule); `null` clears an optional scalar.
export const UpdateProductBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
  icon: z.string().max(8).nullable().optional(),
  services: z.array(ProductServiceBodySchema).max(50).optional(),
  series: z.array(ProductSeriesSchema).max(PRODUCT_SERIES_LIMIT).optional(),
  autoEval: ProductAutoEvalSchema.optional(),
});
export type UpdateProductBody = z.infer<typeof UpdateProductBodySchema>;
