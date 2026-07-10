import { z } from "zod";
import { WorkspaceWithRoleListResponseSchema } from "../workspace/workspace-with-role.js";
import { UserProfileResponseSchema } from "./user-profile.js";

// GET /me response — the resolved Principal (@everdict/auth) spread flat, plus the caller's workspace list
// (when the workspace service is configured) and mutable profile (when one exists). Workspace/roles here are
// what the control plane enforces — the web reads them to role-gate the UI.
export const MeResponseSchema = z.object({
  subject: z.string().describe("Identity key — OIDC sub or API-key identifier"),
  workspace: z.string().describe("Active workspace (= tenant / trust zone) this request resolved to"),
  roles: z.array(z.string()).describe("Roles in the active workspace (viewer|member|admin|runner|ci…)"),
  via: z.enum(["oidc", "api-key", "runner", "github-actions"]).describe("How the credential authenticated"),
  email: z.string().optional().describe("OIDC email claim — display only; absent for API keys"),
  scopes: z
    .array(z.string())
    .optional()
    .describe("Per-API-key permission scopes (read|write|admin); absent = unrestricted (OIDC/legacy key)"),
  runnerId: z.string().optional().describe("Runner device id — only for runner tokens (via=runner)"),
  workspaces: WorkspaceWithRoleListResponseSchema.optional().describe(
    "All workspaces the subject is a member of (present when the workspace service is configured)",
  ),
  profile: UserProfileResponseSchema.optional().describe("Mutable display profile (present when one exists)"),
});
