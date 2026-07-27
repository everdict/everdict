import type { KnowledgeStore } from "@everdict/application-control";
import {
  type EdgeMention,
  EdgeMentionSchema,
  type KnowledgeNode,
  KnowledgeNodeSchema,
  type Mention,
  MentionSchema,
  type Predicate,
  type SourceKind,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// Postgres KnowledgeStore — interchangeable with InMemoryKnowledgeStore (apps swap by DATABASE_URL). Mentions/edges
// append idempotently (ON CONFLICT DO NOTHING — a re-harvest is a no-op); nodes upsert by node_id (ON CONFLICT DO
// UPDATE — a richer projection replaces a stub). Rows are validated back through the contract schemas at the boundary.

const NODE_COLS =
  "node_id, tenant, type, key, version, label, attrs, resolution, evidence_count, first_observed_at, last_observed_at, created_at, updated_at";
const MENTION_COLS =
  "id, tenant, node_type, node_ref, node_attrs, source_kind, source_id, origin, extractor, confidence, evidence_path, evidence_quote, evidence_offset_start, evidence_offset_end, evidence_lang, salience, resolution, resolved_node_id, created_at";
const EDGE_COLS =
  "id, tenant, predicate, subject_mention_id, subject_node_id, subject_type_hint, object_mention_id, object_node_id, object_type_hint, edge_attrs, polarity, source_kind, source_id, origin, extractor, confidence, evidence_path, evidence_quote, evidence_offset_start, evidence_offset_end, evidence_lang, resolution, created_at";

function iso(v: string | Date): string {
  return new Date(v).toISOString();
}
function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function opt<T>(v: T | null): { present: boolean; value: T } {
  return { present: v !== null, value: v as T };
}

interface NodeRow {
  node_id: string;
  tenant: string;
  type: string;
  key: string;
  version: string | null;
  label: string;
  attrs: unknown;
  resolution: string;
  evidence_count: number;
  first_observed_at: string | Date | null;
  last_observed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToNode(r: NodeRow): KnowledgeNode {
  return KnowledgeNodeSchema.parse({
    nodeId: r.node_id,
    tenant: r.tenant,
    type: r.type,
    key: r.key,
    ...(r.version !== null ? { version: r.version } : {}),
    label: r.label,
    attrs: asObject(r.attrs),
    resolution: r.resolution,
    evidenceCount: r.evidence_count,
    ...(r.first_observed_at !== null ? { firstObservedAt: iso(r.first_observed_at) } : {}),
    ...(r.last_observed_at !== null ? { lastObservedAt: iso(r.last_observed_at) } : {}),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  });
}

interface MentionRow {
  id: string;
  tenant: string;
  node_type: string;
  node_ref: string;
  node_attrs: unknown;
  source_kind: string;
  source_id: string;
  origin: string;
  extractor: string;
  confidence: number;
  evidence_path: string | null;
  evidence_quote: string | null;
  evidence_offset_start: number | null;
  evidence_offset_end: number | null;
  evidence_lang: string | null;
  salience: number | null;
  resolution: string;
  resolved_node_id: string | null;
  created_at: string | Date;
}

function rowToMention(r: MentionRow): Mention {
  return MentionSchema.parse({
    id: r.id,
    tenant: r.tenant,
    nodeType: r.node_type,
    nodeRef: r.node_ref,
    nodeAttrs: asObject(r.node_attrs),
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    origin: r.origin,
    extractor: r.extractor,
    confidence: r.confidence,
    ...(r.evidence_path !== null ? { evidencePath: r.evidence_path } : {}),
    ...(r.evidence_quote !== null ? { evidenceQuote: r.evidence_quote } : {}),
    ...(r.evidence_offset_start !== null ? { evidenceOffsetStart: r.evidence_offset_start } : {}),
    ...(r.evidence_offset_end !== null ? { evidenceOffsetEnd: r.evidence_offset_end } : {}),
    ...(r.evidence_lang !== null ? { evidenceLang: r.evidence_lang } : {}),
    ...(r.salience !== null ? { salience: r.salience } : {}),
    resolution: r.resolution,
    ...(r.resolved_node_id !== null ? { resolvedNodeId: r.resolved_node_id } : {}),
    createdAt: iso(r.created_at),
  });
}

interface EdgeRow {
  id: string;
  tenant: string;
  predicate: string;
  subject_mention_id: string | null;
  subject_node_id: string | null;
  subject_type_hint: string | null;
  object_mention_id: string | null;
  object_node_id: string | null;
  object_type_hint: string | null;
  edge_attrs: unknown;
  polarity: string;
  source_kind: string;
  source_id: string;
  origin: string;
  extractor: string;
  confidence: number;
  evidence_path: string | null;
  evidence_quote: string | null;
  evidence_offset_start: number | null;
  evidence_offset_end: number | null;
  evidence_lang: string | null;
  resolution: string;
  created_at: string | Date;
}

function rowToEdge(r: EdgeRow): EdgeMention {
  return EdgeMentionSchema.parse({
    id: r.id,
    tenant: r.tenant,
    predicate: r.predicate,
    ...(r.subject_mention_id !== null ? { subjectMentionId: r.subject_mention_id } : {}),
    ...(r.subject_node_id !== null ? { subjectNodeId: r.subject_node_id } : {}),
    ...(r.subject_type_hint !== null ? { subjectTypeHint: r.subject_type_hint } : {}),
    ...(r.object_mention_id !== null ? { objectMentionId: r.object_mention_id } : {}),
    ...(r.object_node_id !== null ? { objectNodeId: r.object_node_id } : {}),
    ...(r.object_type_hint !== null ? { objectTypeHint: r.object_type_hint } : {}),
    edgeAttrs: asObject(r.edge_attrs),
    polarity: r.polarity,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    origin: r.origin,
    extractor: r.extractor,
    confidence: r.confidence,
    ...(r.evidence_path !== null ? { evidencePath: r.evidence_path } : {}),
    ...(r.evidence_quote !== null ? { evidenceQuote: r.evidence_quote } : {}),
    ...(r.evidence_offset_start !== null ? { evidenceOffsetStart: r.evidence_offset_start } : {}),
    ...(r.evidence_offset_end !== null ? { evidenceOffsetEnd: r.evidence_offset_end } : {}),
    ...(r.evidence_lang !== null ? { evidenceLang: r.evidence_lang } : {}),
    resolution: r.resolution,
    createdAt: iso(r.created_at),
  });
}

export class PgKnowledgeStore implements KnowledgeStore {
  constructor(private readonly client: SqlClient) {}

  async putNodes(nodes: KnowledgeNode[]): Promise<void> {
    for (const n of nodes) {
      await this.client.query(
        `INSERT INTO everdict_knowledge_nodes (${NODE_COLS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (node_id) DO UPDATE SET
           label = EXCLUDED.label, attrs = EXCLUDED.attrs, resolution = EXCLUDED.resolution,
           evidence_count = EXCLUDED.evidence_count, last_observed_at = EXCLUDED.last_observed_at,
           updated_at = EXCLUDED.updated_at`,
        [
          n.nodeId,
          n.tenant,
          n.type,
          n.key,
          n.version ?? null,
          n.label,
          JSON.stringify(n.attrs),
          n.resolution,
          n.evidenceCount,
          n.firstObservedAt ?? null,
          n.lastObservedAt ?? null,
          n.createdAt,
          n.updatedAt,
        ],
      );
    }
  }

  async putMentions(mentions: Mention[]): Promise<void> {
    for (const m of mentions) {
      await this.client.query(
        `INSERT INTO everdict_knowledge_mentions (${MENTION_COLS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO NOTHING`,
        [
          m.id,
          m.tenant,
          m.nodeType,
          m.nodeRef,
          JSON.stringify(m.nodeAttrs),
          m.sourceKind,
          m.sourceId,
          m.origin,
          m.extractor,
          m.confidence,
          m.evidencePath ?? null,
          m.evidenceQuote ?? null,
          m.evidenceOffsetStart ?? null,
          m.evidenceOffsetEnd ?? null,
          m.evidenceLang ?? null,
          m.salience ?? null,
          m.resolution,
          m.resolvedNodeId ?? null,
          m.createdAt,
        ],
      );
    }
  }

  async putEdges(edges: EdgeMention[]): Promise<void> {
    for (const e of edges) {
      await this.client.query(
        `INSERT INTO everdict_knowledge_edges (${EDGE_COLS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT (id) DO NOTHING`,
        [
          e.id,
          e.tenant,
          e.predicate,
          e.subjectMentionId ?? null,
          e.subjectNodeId ?? null,
          e.subjectTypeHint ?? null,
          e.objectMentionId ?? null,
          e.objectNodeId ?? null,
          e.objectTypeHint ?? null,
          JSON.stringify(e.edgeAttrs),
          e.polarity,
          e.sourceKind,
          e.sourceId,
          e.origin,
          e.extractor,
          e.confidence,
          e.evidencePath ?? null,
          e.evidenceQuote ?? null,
          e.evidenceOffsetStart ?? null,
          e.evidenceOffsetEnd ?? null,
          e.evidenceLang ?? null,
          e.resolution,
          e.createdAt,
        ],
      );
    }
  }

  async getNode(tenant: string, nodeId: string): Promise<KnowledgeNode | undefined> {
    const res = await this.client.query<NodeRow>(
      `SELECT ${NODE_COLS} FROM everdict_knowledge_nodes WHERE tenant = $1 AND node_id = $2`,
      [tenant, nodeId],
    );
    return res.rows[0] ? rowToNode(res.rows[0]) : undefined;
  }

  async outgoing(tenant: string, subjectNodeId: string, predicate?: Predicate): Promise<EdgeMention[]> {
    const { present, value } = opt(predicate ?? null);
    const res = await this.client.query<EdgeRow>(
      `SELECT ${EDGE_COLS} FROM everdict_knowledge_edges
       WHERE tenant = $1 AND subject_node_id = $2${present ? " AND predicate = $3" : ""}`,
      present ? [tenant, subjectNodeId, value] : [tenant, subjectNodeId],
    );
    return res.rows.map(rowToEdge);
  }

  async incoming(tenant: string, objectNodeId: string, predicate?: Predicate): Promise<EdgeMention[]> {
    const { present, value } = opt(predicate ?? null);
    const res = await this.client.query<EdgeRow>(
      `SELECT ${EDGE_COLS} FROM everdict_knowledge_edges
       WHERE tenant = $1 AND object_node_id = $2${present ? " AND predicate = $3" : ""}`,
      present ? [tenant, objectNodeId, value] : [tenant, objectNodeId],
    );
    return res.rows.map(rowToEdge);
  }

  async listMentions(tenant: string, sourceKind: SourceKind, sourceId: string): Promise<Mention[]> {
    const res = await this.client.query<MentionRow>(
      `SELECT ${MENTION_COLS} FROM everdict_knowledge_mentions
       WHERE tenant = $1 AND source_kind = $2 AND source_id = $3`,
      [tenant, sourceKind, sourceId],
    );
    return res.rows.map(rowToMention);
  }

  async notesForNode(tenant: string, nodeId: string): Promise<Mention[]> {
    const res = await this.client.query<MentionRow>(
      `SELECT ${MENTION_COLS} FROM everdict_knowledge_mentions
       WHERE tenant = $1 AND resolved_node_id = $2 AND origin = 'authored'
       ORDER BY created_at DESC`,
      [tenant, nodeId],
    );
    return res.rows.map(rowToMention);
  }
}
