// @everdict/contracts — the reference vocabulary knowledge entries and skills are written in.
//
// A knowledge entry (records/knowledge-entry.ts) and a skill (records/skill.ts) point at the workspace entities they
// concern through `NodeRef`s — `{type, key, version?}` over the closed `NODE_TYPES` vocabulary — and pin them on the
// subject-time axis (`KnowledgePin`). An extraction-born entry records which text surface it came out of
// (`SOURCE_KINDS`). Stored rows are parsed against these enums, so their values are part of the storage contract.
// SSOT: docs/architecture/workspace-knowledge.md.
export * from "./node-type.js";
export * from "./source-kind.js";
export * from "./node-ref.js";
