import type { AnalysisArtifactRecord } from "@everdict/contracts";

// Persistence for the agent's analysis artifacts (charts/tables/reports — docs/architecture/analysis-studio.md V2).
// Artifacts belong to a conversation (sessionId) within a workspace; a View-attached subset (viewId/pinned) powers
// the Studio gallery (V3) and the scheduled-report archive (V4). async — Postgres honors the same contract.
export interface AnalysisArtifactStore {
  create(record: AnalysisArtifactRecord): Promise<void>;
  get(tenant: string, id: string): Promise<AnalysisArtifactRecord | undefined>;
  // Oldest first (createdAt ascending) — interleaves with the session transcript by time.
  listBySession(tenant: string, sessionId: string): Promise<AnalysisArtifactRecord[]>;
  // Attach an artifact to a View and pin it (Studio gallery / scheduled-report archive). No-op on a missing id.
  attachToView(tenant: string, id: string, viewId: string): Promise<void>;
  // Newest first — the View's pinned gallery / report archive. Visibility is the CALLER's job (the view's
  // private|workspace gate lives in the control plane; the agent route verifies access before listing).
  listByView(tenant: string, viewId: string): Promise<AnalysisArtifactRecord[]>;
}
