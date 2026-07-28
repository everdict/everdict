// Comment-thread display model — assembled by the server (page) and passed to the client component (actor resolution/permission computation done).
export interface Mentionable {
  subject: string
  name: string
  avatarUrl?: string
  isAgent?: boolean // the synthetic @everdict entry — picking it asks the agent (never a notify target)
}

export type AgentCommentStatus = 'running' | 'awaiting_approval' | 'complete' | 'failed'

export interface ThreadComment {
  id: string
  parentId?: string
  actor: { name: string; avatarUrl?: string; known: boolean }
  body: string
  at: string
  canDelete: boolean
  // Agent-answer fields (@everdict) — present only on agent-authored comments.
  isAgent?: boolean
  agentStatus?: AgentCommentStatus
  agentActivity?: string // machine token ("thinking"|"writing"|"tool:<name>") — localized at render
  agentSessionId?: string // the backing workspace-visible conversation (detail/continue surface)
}
