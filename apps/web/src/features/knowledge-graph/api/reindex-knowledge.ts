'use server'

import { z } from 'zod'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

const reindexResultSchema = z.object({
  scanned: z.number(),
  nodes: z.number(),
  edges: z.number(),
})

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface ReindexKnowledgeResult {
  ok: boolean
  scanned?: number
  nodes?: number
  edges?: number
  error?: string
}

// Rebuild the workspace's knowledge graph from its existing records + registry entities (POST /knowledge/reindex,
// settings:write — enforced by the control plane). Idempotent. 새 그래프는 부른 쪽(knowledge-explorer)의
// `refresh()` 가 다시 읽어 온다.
export async function reindexKnowledgeAction(): Promise<ReindexKnowledgeResult> {
  const ctx = await authContext()
  try {
    const r = reindexResultSchema.parse(await controlPlane.reindexKnowledge(ctx))
    return { ok: true, scanned: r.scanned, nodes: r.nodes, edges: r.edges }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
