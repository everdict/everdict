-- 0087_knowledge_entry_extraction — additive (expand): extraction provenance for knowledge entries
-- (docs/architecture/knowledge-graph.md §The accumulation loop). A `proposed` entry is an extraction CANDIDATE drawn
-- from a text surface (a comment thread) by the extractor; `extraction` records where it came from ((sourceKind,
-- sourceId) — the same audit tuple the mention spine uses), the extractor version, and its confidence. The field
-- survives approval (status proposed → active + authorship transfer) as the claim's origin trail.
ALTER TABLE everdict_knowledge_entries
  ADD COLUMN IF NOT EXISTS extraction jsonb;
