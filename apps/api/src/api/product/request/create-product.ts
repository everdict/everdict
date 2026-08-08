import {
  PRODUCT_SERIES_LIMIT,
  ProductAutoEvalSchema,
  ProductSeriesSchema,
  ProductServiceSchema,
} from "@everdict/contracts";
import { z } from "zod";

// The client never sends sync state — the watermark belongs to the sync, and the aggregate carries it across
// edits (dropping it only when the source coordinates change).
export const ProductServiceBodySchema = ProductServiceSchema.omit({ sync: true });

export const CreateProductBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  icon: z.string().max(8).optional(),
  services: z.array(ProductServiceBodySchema).max(50).optional(),
  series: z.array(ProductSeriesSchema).max(PRODUCT_SERIES_LIMIT).optional(),
  autoEval: ProductAutoEvalSchema.optional(),
});
export type CreateProductBody = z.infer<typeof CreateProductBodySchema>;
