import { z } from 'zod'

// Control-plane GET /workspaces item (workspaces I'm a member of + my role). Mirrors the API shape with zod.
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  logoUrl: z.string().optional(), // for the sidebar/switcher display
})
export type Workspace = z.infer<typeof workspaceSchema>

export const workspacesSchema = z.array(workspaceSchema)

// Control-plane GET /workspace (singular) — the active workspace record (for the settings page). owner determines delete permission.
export const workspaceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  logoUrl: z.string().optional(),
  createdAt: z.string(),
})
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>

export const workspaceUrlBase = 'workspace.everdict.io' // for read-only URL display (slug = id)
