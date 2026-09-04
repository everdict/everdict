'use server'

import { z } from 'zod'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

const reindexResultSchema = z.object({
  scanned: z.number(),
  nodes: z.number(),
  edges: z.number(),
})

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the DECLARATION
// alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface ReindexKnowledgeResult {
  ok: boolean
  scanned?: number
  nodes?: number
  edges?: number
  error?: string
}

// Rebuild the workspace's knowledge graph from its existing records + registry entities (POST /knowledge/reindex,
// settings:write — enforced by the control plane). Idempotent. The new graph is re-read by the caller's
// (knowledge-explorer's) `refresh()`.
export async function reindexKnowledgeAction(): Promise<ReindexKnowledgeResult> {
  const ctx = await authContext()
  try {
    const r = reindexResultSchema.parse(await controlPlane.reindexKnowledge(ctx))
    return { ok: true, scanned: r.scanned, nodes: r.nodes, edges: r.edges }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
