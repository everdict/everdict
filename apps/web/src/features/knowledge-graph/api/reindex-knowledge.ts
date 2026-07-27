'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

const reindexResultSchema = z.object({
  scanned: z.number(),
  nodes: z.number(),
  edges: z.number(),
})

export interface ReindexKnowledgeResult {
  ok: boolean
  scanned?: number
  nodes?: number
  edges?: number
  error?: string
}

// Rebuild the workspace's knowledge graph from its existing records + registry entities (POST /knowledge/reindex,
// settings:write — enforced by the control plane). Idempotent. On success we revalidate the settings tree so the page
// re-fetches the fresh graph.
export async function reindexKnowledgeAction(): Promise<ReindexKnowledgeResult> {
  const ctx = await authContext()
  try {
    const r = reindexResultSchema.parse(await controlPlane.reindexKnowledge(ctx))
    revalidatePath('/[workspace]/settings')
    return { ok: true, scanned: r.scanned, nodes: r.nodes, edges: r.edges }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
