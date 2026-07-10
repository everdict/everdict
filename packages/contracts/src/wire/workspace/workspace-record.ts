import { z } from "zod";

// The active workspace's metadata record (db WorkspaceRecord — see packages/db workspace-store.ts).
export const WorkspaceRecordResponseSchema = z.object({
  id: z.string().describe("Workspace id (slug) — the tenant key, immutable"),
  name: z.string().describe("Display name"),
  owner: z.string().describe("The subject who created the workspace (only the owner can delete it)"),
  logoUrl: z.string().optional().describe("Workspace logo (http(s) URL or data:image base64)"),
  createdAt: z.string().describe("ISO 8601 creation time"),
});
