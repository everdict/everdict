// Comment-thread display model — assembled by the server (page) and passed to the client component (actor resolution/permission computation done).
export interface Mentionable {
  subject: string
  name: string
  avatarUrl?: string
}

export interface ThreadComment {
  id: string
  parentId?: string
  actor: { name: string; avatarUrl?: string; known: boolean }
  body: string
  at: string
  canDelete: boolean
}
