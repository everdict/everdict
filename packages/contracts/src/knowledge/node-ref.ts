import { z } from "zod";
import { NodeTypeSchema } from "./node-type.js";

// A stable, structural reference to a workspace entity — the handle a knowledge entry's `refs`/`evidence`, a skill's
// `refs` and a task-context anchor all use. The generalisation of `AgentReference` (`{type,id,version,label}`) that
// user turns already carry. `key` is the entity's natural key WITHIN its `(tenant, type)`: a registry id, a record
// UUID, a repo "owner/name", a user subject, or a composite like `${datasetId}#${caseId}`. `version` is present only
// for immutable-versioned registry entities, and it is part of what the reference names: a claim about harness
// web@1.0.0 is not a claim about web@2.0.0.
export const NodeRefSchema = z.object({
  type: NodeTypeSchema,
  key: z.string().min(1),
  version: z.string().optional(),
});
export type NodeRef = z.infer<typeof NodeRefSchema>;

// A knowledge PIN — a NodeRef extended with the claim's known-valid INTERVAL along the entity's timeline:
// `[version, verifiedVersion]`. `version` is the subject-time point the knowledge was first observed at (immutable —
// re-pinning to latest would erase the origin); `verifiedVersion` is the latest point where the claim was CONFIRMED to
// still hold (system-maintained: `verify` resolves each pinned family's current latest and extends it — a coordinate
// extension along subject time, not a wall-clock stamp). Absent verifiedVersion ⇒ the interval is the point
// [version, version] (backward compatible with v1 pins). An unversioned pin is a timeless family-wide claim (its
// temporal signal is wall-clock verifiedAt on the record). Time is a COORDINATE of knowledge, not decay — see
// docs/architecture/workspace-knowledge.md §The time axis.
export const KnowledgePinSchema = NodeRefSchema.extend({
  verifiedVersion: z.string().optional(),
});
export type KnowledgePin = z.infer<typeof KnowledgePinSchema>;
