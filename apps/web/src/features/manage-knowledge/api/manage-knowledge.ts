'use server'

import { revalidatePath } from 'next/cache'

import { knowledgeEntrySchema, type KnowledgeEntry, type NodeRefView } from '@/entities/knowledge'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface KnowledgeEntryActionResult {
  ok: boolean
  entry?: KnowledgeEntry
  error?: string
}

// 지식 엔트리 저작(POST /knowledge/entries). visibility 기본 private(개인 초안). refs=버전핀 앵커(→about 엣지, staleness 계약),
// evidence=근거 관측(→evidenced_by 엣지). authZ(comments:write)는 컨트롤플레인이 강제.
export async function createKnowledgeEntryAction(body: {
  kind: 'finding' | 'decision' | 'convention' | 'context'
  title: string
  body: string
  refs?: NodeRefView[]
  evidence?: NodeRefView[]
  supersedes?: string
  visibility?: 'private' | 'workspace'
}): Promise<KnowledgeEntryActionResult> {
  const ctx = await authContext()
  try {
    const entry = knowledgeEntrySchema.parse(await controlPlane.createKnowledgeEntry(ctx, body))
    revalidatePath('/[workspace]/knowledge', 'page')
    return { ok: true, entry }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 지식 엔트리 편집(PATCH /knowledge/entries/:id). refs/evidence 는 주면 통째 교체. status=deprecate/재활성 등 명시적 전환.
// 관리는 작성자-or-admin(컨트롤플레인).
export async function updateKnowledgeEntryAction(
  id: string,
  patch: {
    kind?: 'finding' | 'decision' | 'convention' | 'context'
    title?: string
    body?: string
    refs?: NodeRefView[]
    evidence?: NodeRefView[]
    status?: 'active' | 'superseded' | 'deprecated'
    visibility?: 'private' | 'workspace'
  }
): Promise<KnowledgeEntryActionResult> {
  const ctx = await authContext()
  try {
    const entry = knowledgeEntrySchema.parse(
      await controlPlane.updateKnowledgeEntry(ctx, id, patch)
    )
    revalidatePath('/[workspace]/knowledge', 'page')
    return { ok: true, entry }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// "아직 유효함" 검증(POST /knowledge/entries/:id/verify) — verifiedAt 만 찍고 updatedAt 은 건드리지 않음(편집이 아님).
export async function verifyKnowledgeEntryAction(id: string): Promise<KnowledgeEntryActionResult> {
  const ctx = await authContext()
  try {
    const entry = knowledgeEntrySchema.parse(await controlPlane.verifyKnowledgeEntry(ctx, id))
    revalidatePath('/[workspace]/knowledge', 'page')
    return { ok: true, entry }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 지식 엔트리 삭제(DELETE /knowledge/entries/:id). 작성자-or-admin(컨트롤플레인).
export async function deleteKnowledgeEntryAction(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteKnowledgeEntry(ctx, id)
    revalidatePath('/[workspace]/knowledge', 'page')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 제안 승인(POST /knowledge/entries/:id/approve) — proposed→active + 승인자에게 저작권 이전(추출 출처는 감사용 유지).
export async function approveKnowledgeEntryAction(id: string): Promise<KnowledgeEntryActionResult> {
  const ctx = await authContext()
  try {
    const entry = knowledgeEntrySchema.parse(await controlPlane.approveKnowledgeEntry(ctx, id))
    revalidatePath('/[workspace]/knowledge', 'page')
    return { ok: true, entry }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 제안 거부(POST /knowledge/entries/:id/reject) — 후보 삭제. proposed 전용(그 외 409).
export async function rejectKnowledgeEntryAction(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.rejectKnowledgeEntry(ctx, id)
    revalidatePath('/[workspace]/knowledge', 'page')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
