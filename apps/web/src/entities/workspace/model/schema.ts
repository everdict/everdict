import type { WorkspaceRecordResponse, WorkspaceWithRoleResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4) so these local schemas can no longer silently drift from the control plane.
// `import type` only — the zod v3 wire schemas never run in the web.

// Control-plane GET /workspaces item (workspaces I'm a member of + my role). Mirrors WorkspaceWithRoleResponse.
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  logoUrl: z.string().optional(), // for the sidebar/switcher display
})

export const workspacesSchema = z.array(workspaceSchema)

// Control-plane GET /workspace (singular) — the active workspace record (for the settings page). owner determines delete permission.
export const workspaceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  logoUrl: z.string().optional(),
  createdAt: z.string(),
})

// The read-only workspace URL (slug = id) is `<base>/<id>`, where the base is resolved server-side from the
// request origin (or the WORKSPACE_URL_BASE override) — see features/workspace-settings resolveWorkspaceUrlBase.

// Drift guards — both are identical-shape entities (the web models every wire field and no extra), so the
// guard is bidirectional: a renamed/dropped/added field or a widened enum on EITHER side stops one binding
// compiling and the web typecheck fails. That is what makes deleting the hand mirror safe.
type AssertAssignable<A extends B, B> = A
type WebWorkspace = z.infer<typeof workspaceSchema>
type WebWorkspaceRecord = z.infer<typeof workspaceRecordSchema>
type _workspaceFwd = AssertAssignable<WebWorkspace, WorkspaceWithRoleResponse>
type _workspaceBack = AssertAssignable<WorkspaceWithRoleResponse, WebWorkspace>
type _recordFwd = AssertAssignable<WebWorkspaceRecord, WorkspaceRecordResponse>
type _recordBack = AssertAssignable<WorkspaceRecordResponse, WebWorkspaceRecord>

// Exported names alias the contract types (consumers untouched: same Workspace / WorkspaceRecord identifiers).
export type Workspace = WorkspaceWithRoleResponse
export type WorkspaceRecord = WorkspaceRecordResponse

export type __workspaceDriftGuard = [_workspaceFwd, _workspaceBack, _recordFwd, _recordBack]
