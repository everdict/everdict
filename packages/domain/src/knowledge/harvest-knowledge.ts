import type { KnowledgeEntryRecord, SkillRecord } from "@everdict/contracts";
import { HarvestBuilder, type HarvestResult } from "./harvest.js";

// Structured harvesters for the KNOWLEDGE LAYER records — the claim stratum over the entity graph. Both project their
// record's `refs` through the deliberately GENERIC `about` predicate (specificity lives in the record body, not the
// edge), which is what makes a skill/claim reachable from the entities it concerns (task-time context assembly) and
// what powers staleness detection (a version-pinned `about` target that has moved on). Pure and deterministic, like
// every other record harvester. See docs/architecture/knowledge-graph.md §The knowledge layer.

export const SKILL_HARVESTER = "skill_harvester_v1";
export const KNOWLEDGE_ENTRY_HARVESTER = "knowledge_entry_harvester_v1";

// A SkillRecord — a task procedure bundle. Its `refs` are the version-PINNED entities the procedure documents.
export function harvestSkill(s: SkillRecord): HarvestResult {
  const attrs: Record<string, unknown> = { visibility: s.visibility, files: s.files.length };
  if (s.verifiedAt !== undefined) attrs.verifiedAt = s.verifiedAt;
  const b = new HarvestBuilder(s.tenant, "skill", s.id, SKILL_HARVESTER, s.updatedAt, s.createdAt).self(
    { type: "skill", key: s.id },
    s.name,
    attrs,
  );
  b.ref("in_workspace", { type: "workspace", key: s.tenant }, "tenant");
  b.ref("created_by", { type: "user", key: s.createdBy }, "createdBy");
  s.refs.forEach((r, i) => b.ref("about", r, `refs[${i}]`));
  return b.result();
}

// A KnowledgeEntryRecord — a reified claim. `refs` → `about` (what it concerns), `evidence` → `evidenced_by` (the
// observations backing it), `supersedes` → the prior entry it revises (knowledge has revision lineage too).
export function harvestKnowledgeEntry(e: KnowledgeEntryRecord): HarvestResult {
  const attrs: Record<string, unknown> = { kind: e.kind, status: e.status, visibility: e.visibility };
  if (e.verifiedAt !== undefined) attrs.verifiedAt = e.verifiedAt;
  const b = new HarvestBuilder(
    e.tenant,
    "knowledge_entry",
    e.id,
    KNOWLEDGE_ENTRY_HARVESTER,
    e.updatedAt,
    e.createdAt,
  ).self({ type: "knowledge", key: e.id }, e.title, attrs);
  b.ref("in_workspace", { type: "workspace", key: e.tenant }, "tenant");
  b.ref("created_by", { type: "user", key: e.createdBy }, "createdBy");
  e.refs.forEach((r, i) => b.ref("about", r, `refs[${i}]`));
  e.evidence.forEach((r, i) => b.ref("evidenced_by", r, `evidence[${i}]`));
  if (e.supersedes !== undefined && e.supersedes !== "")
    b.ref("supersedes", { type: "knowledge", key: e.supersedes }, "supersedes");
  return b.result();
}
