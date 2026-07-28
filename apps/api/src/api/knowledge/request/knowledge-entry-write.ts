import {
  KNOWLEDGE_ENTRY_MAX_REFS,
  KnowledgeEntryKindSchema,
  KnowledgeEntryStatusSchema,
  KnowledgeEntryVisibilitySchema,
  NodeRefSchema,
} from "@everdict/contracts";
import { z } from "zod";

// POST /knowledge/entries body — contribute a reified claim (finding/decision/convention/context). visibility
// defaults to "private" (a personal draft); sharing to the workspace is an explicit opt-in. `refs` = what the claim
// concerns (version-pinned → `about` edges); `evidence` = the observations backing it (→ `evidenced_by` edges);
// `supersedes` = the entry this one revises (the old entry's status stays an explicit, gated write).
export const CreateKnowledgeEntryBodySchema = z.object({
  kind: KnowledgeEntryKindSchema,
  title: z.string().min(1).max(300),
  body: z.string().min(1),
  refs: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
  evidence: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
  supersedes: z.string().min(1).optional(),
  visibility: KnowledgeEntryVisibilitySchema.optional(),
});

// PATCH /knowledge/entries/:id body — edit a claim, re-pin its refs, change status (deprecate / mark superseded) or
// visibility. Every field optional; `refs`/`evidence` replace the whole set when present. Manage = creator-or-admin.
export const UpdateKnowledgeEntryBodySchema = z
  .object({
    kind: KnowledgeEntryKindSchema.optional(),
    title: z.string().min(1).max(300).optional(),
    body: z.string().min(1).optional(),
    refs: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
    evidence: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
    status: KnowledgeEntryStatusSchema.optional(),
    visibility: KnowledgeEntryVisibilitySchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "at least one field is required" });

// POST /knowledge/context body — assemble task-time context for a set of anchors (the entities the task concerns).
// POST because anchors are structured NodeRefs (keys may contain '/' and ':'), which do not survive a query string.
export const AssembleContextBodySchema = z.object({
  refs: z.array(NodeRefSchema).min(1).max(KNOWLEDGE_ENTRY_MAX_REFS),
});
