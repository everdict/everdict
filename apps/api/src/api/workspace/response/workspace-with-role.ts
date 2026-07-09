import { z } from "zod";

// A workspace from the caller's perspective — membership role included (db WorkspaceWithRole).
// POST /workspaces returns the same shape with role always "admin" (the creator) and no logoUrl yet.
export const WorkspaceWithRoleResponseSchema = z.object({
  id: z.string().describe("Workspace id (slug) — the tenant key"),
  name: z.string().describe("Display name"),
  role: z.string().describe("The caller's membership role in this workspace (viewer|member|admin)"),
  logoUrl: z.string().optional().describe("Workspace logo (http(s) URL or data:image base64)"),
});

export const WorkspaceWithRoleListResponseSchema = z.array(WorkspaceWithRoleResponseSchema);
