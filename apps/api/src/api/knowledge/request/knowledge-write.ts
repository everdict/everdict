import { NodeRefSchema, PredicateSchema } from "@everdict/contracts";
import { z } from "zod";

// Request DTOs for the AUTHORED write path — a user or agent (from Claude Code via the everdict plugin) contributing
// knowledge. A node is identified by a NodeRef ({type, key, version?}); the service derives its content-addressed id.

// Attach a free-form note/observation to a node.
export const AnnotateKnowledgeBodySchema = z.object({
  node: NodeRefSchema,
  note: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
});
export type AnnotateKnowledgeBody = z.infer<typeof AnnotateKnowledgeBodySchema>;

// Assert a typed relationship (closed predicate vocabulary) between two nodes.
export const RelateKnowledgeBodySchema = z.object({
  subject: NodeRefSchema,
  predicate: PredicateSchema,
  object: NodeRefSchema,
  note: z.string().optional(),
  confidence: z.number().min(0).max(1).default(1),
});
export type RelateKnowledgeBody = z.infer<typeof RelateKnowledgeBodySchema>;
