import { NodeTypeSchema, PredicateSchema } from "@everdict/contracts";
import { z } from "zod";

// Query DTOs for the knowledge-graph read routes. The node id is a QUERY param (`id`), not a path segment — a node id
// can contain `/` (a repo "owner/name") and `:`/`@`, which do not survive as a path parameter. `predicates`/`nodeTypes`
// arrive as comma-separated lists and are strictly validated against the closed vocabularies (a bad value → 400).

const DirectionSchema = z.enum(["out", "in", "both"]);

function csvOf<T extends z.ZodTypeAny>(item: T): z.ZodOptional<z.ZodType<z.infer<T>[], z.ZodTypeDef, string>> {
  return z
    .string()
    .transform((s, ctx) => {
      const out: z.infer<T>[] = [];
      for (const raw of s
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0)) {
        const parsed = item.safeParse(raw);
        if (!parsed.success) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid value: ${raw}` });
          return z.NEVER;
        }
        out.push(parsed.data);
      }
      return out;
    })
    .optional();
}

export const KnowledgeRelatedQuerySchema = z.object({
  id: z.string().min(1),
  direction: DirectionSchema.optional(),
  predicates: csvOf(PredicateSchema),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
export type KnowledgeRelatedQuery = z.infer<typeof KnowledgeRelatedQuerySchema>;

export const KnowledgeSubgraphQuerySchema = z.object({
  id: z.string().min(1),
  depth: z.coerce.number().int().min(0).max(5).optional(),
  direction: DirectionSchema.optional(),
  predicates: csvOf(PredicateSchema),
  nodeTypes: csvOf(NodeTypeSchema),
});
export type KnowledgeSubgraphQuery = z.infer<typeof KnowledgeSubgraphQuerySchema>;
