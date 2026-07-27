import type { AnalysisArtifactStore } from "@everdict/application-control";
import { type AnalysisArtifactRecord, AnalysisArtifactRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// Analysis artifacts (docs/architecture/analysis-studio.md V2) — the agent's chart/table/report outputs.
// spec is opaque jsonb (validated per kind at the emission boundary, so a stored spec is always renderable).

export class InMemoryAnalysisArtifactStore implements AnalysisArtifactStore {
  private readonly artifacts: AnalysisArtifactRecord[] = [];

  async create(record: AnalysisArtifactRecord): Promise<void> {
    this.artifacts.push(record);
  }

  async get(tenant: string, id: string): Promise<AnalysisArtifactRecord | undefined> {
    return this.artifacts.find((a) => a.tenant === tenant && a.id === id);
  }

  async listBySession(tenant: string, sessionId: string): Promise<AnalysisArtifactRecord[]> {
    return this.artifacts
      .filter((a) => a.tenant === tenant && a.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async attachToView(tenant: string, id: string, viewId: string): Promise<void> {
    const artifact = this.artifacts.find((a) => a.tenant === tenant && a.id === id);
    if (!artifact) return;
    artifact.viewId = viewId;
    artifact.pinned = true;
  }

  async listByView(tenant: string, viewId: string): Promise<AnalysisArtifactRecord[]> {
    return this.artifacts
      .filter((a) => a.tenant === tenant && a.viewId === viewId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

interface ArtifactRow {
  id: string;
  tenant: string;
  kind: string;
  title: string;
  session_id: string;
  view_id: string | null;
  pinned: boolean;
  spec: unknown;
  created_by: string;
  created_at: string | Date;
}

function rowToRecord(row: ArtifactRow): AnalysisArtifactRecord {
  return AnalysisArtifactRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    kind: row.kind,
    title: row.title,
    sessionId: row.session_id,
    ...(row.view_id !== null ? { viewId: row.view_id } : {}),
    pinned: row.pinned,
    spec: row.spec,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

const COLUMNS = "id, tenant, kind, title, session_id, view_id, pinned, spec, created_by, created_at";

export class PgAnalysisArtifactStore implements AnalysisArtifactStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: AnalysisArtifactRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_analysis_artifacts (${COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        record.id,
        record.tenant,
        record.kind,
        record.title,
        record.sessionId,
        record.viewId ?? null,
        record.pinned,
        JSON.stringify(record.spec ?? null),
        record.createdBy,
        record.createdAt,
      ],
    );
  }

  async get(tenant: string, id: string): Promise<AnalysisArtifactRecord | undefined> {
    const res = await this.client.query<ArtifactRow>(
      `SELECT ${COLUMNS} FROM everdict_analysis_artifacts WHERE tenant = $1 AND id = $2`,
      [tenant, id],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async listBySession(tenant: string, sessionId: string): Promise<AnalysisArtifactRecord[]> {
    const res = await this.client.query<ArtifactRow>(
      `SELECT ${COLUMNS} FROM everdict_analysis_artifacts WHERE tenant = $1 AND session_id = $2
       ORDER BY created_at ASC, id ASC`,
      [tenant, sessionId],
    );
    return res.rows.map(rowToRecord);
  }

  async attachToView(tenant: string, id: string, viewId: string): Promise<void> {
    await this.client.query(
      "UPDATE everdict_analysis_artifacts SET view_id = $3, pinned = true WHERE tenant = $1 AND id = $2",
      [tenant, id, viewId],
    );
  }

  async listByView(tenant: string, viewId: string): Promise<AnalysisArtifactRecord[]> {
    const res = await this.client.query<ArtifactRow>(
      `SELECT ${COLUMNS} FROM everdict_analysis_artifacts WHERE tenant = $1 AND view_id = $2
       ORDER BY created_at DESC, id DESC`,
      [tenant, viewId],
    );
    return res.rows.map(rowToRecord);
  }
}
