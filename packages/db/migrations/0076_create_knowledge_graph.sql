-- 0076_create_knowledge_graph — additive (expand): the workspace knowledge graph (docs/architecture/knowledge-graph.md).
-- Three tables mirror the type-agnostic mention spine + the canonical node projection. Mentions/edges are APPEND-ONLY
-- (idempotent by id — a re-harvest DOes NOTHING on conflict); nodes UPSERT by node_id (a richer harvester replaces a
-- stub). attrs/node_attrs/edge_attrs are jsonb (type-agnostic — no per-type columns). All additive, no preflight.

-- Canonical node projection (one type-agnostic table; everdict entities already own identity).
CREATE TABLE IF NOT EXISTS everdict_knowledge_nodes (
  node_id           text PRIMARY KEY,
  tenant            text NOT NULL,
  type              text NOT NULL,
  key               text NOT NULL,
  version           text,
  label             text NOT NULL,
  attrs             jsonb NOT NULL DEFAULT '{}',
  resolution        text NOT NULL DEFAULT 'resolved',
  evidence_count    integer NOT NULL DEFAULT 0,
  first_observed_at timestamptz,
  last_observed_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS everdict_knowledge_nodes_type_idx ON everdict_knowledge_nodes (tenant, type);

-- Mention spine — one observed reference to a node, from one source. Append-only.
CREATE TABLE IF NOT EXISTS everdict_knowledge_mentions (
  id                    text PRIMARY KEY,
  tenant                text NOT NULL,
  node_type             text NOT NULL,
  node_ref              text NOT NULL,
  node_attrs            jsonb NOT NULL DEFAULT '{}',
  source_kind           text NOT NULL,
  source_id             text NOT NULL,
  origin                text NOT NULL,
  extractor             text NOT NULL,
  confidence            double precision NOT NULL,
  evidence_path         text,
  evidence_quote        text,
  evidence_offset_start integer,
  evidence_offset_end   integer,
  evidence_lang         text,
  salience              double precision,
  resolution            text NOT NULL DEFAULT 'pending',
  resolved_node_id      text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS everdict_knowledge_mentions_source_idx
  ON everdict_knowledge_mentions (tenant, source_kind, source_id);
CREATE INDEX IF NOT EXISTS everdict_knowledge_mentions_resolved_idx
  ON everdict_knowledge_mentions (tenant, resolved_node_id);

-- Edge spine — one observed relationship between two nodes, from one source. Append-only. A side is referenced by
-- mention id (pre-resolution) XOR node id (resolved) — the resolved graph queries use *_node_id.
CREATE TABLE IF NOT EXISTS everdict_knowledge_edges (
  id                    text PRIMARY KEY,
  tenant                text NOT NULL,
  predicate             text NOT NULL,
  subject_mention_id    text,
  subject_node_id       text,
  subject_type_hint     text,
  object_mention_id     text,
  object_node_id        text,
  object_type_hint      text,
  edge_attrs            jsonb NOT NULL DEFAULT '{}',
  polarity              text NOT NULL DEFAULT 'affirmed',
  source_kind           text NOT NULL,
  source_id             text NOT NULL,
  origin                text NOT NULL,
  extractor             text NOT NULL,
  confidence            double precision NOT NULL,
  evidence_path         text,
  evidence_quote        text,
  evidence_offset_start integer,
  evidence_offset_end   integer,
  evidence_lang         text,
  resolution            text NOT NULL DEFAULT 'pending',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS everdict_knowledge_edges_subject_idx
  ON everdict_knowledge_edges (tenant, subject_node_id, predicate);
CREATE INDEX IF NOT EXISTS everdict_knowledge_edges_object_idx
  ON everdict_knowledge_edges (tenant, object_node_id, predicate);
