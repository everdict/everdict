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

// Authoring a knowledge entry (POST /knowledge/entries). visibility defaults to private (a personal draft). refs = version-pinned anchors (→ about edges, the staleness contract),
// evidence = the observations it rests on (→ evidenced_by edges). AuthZ (comments:write) is enforced by the control plane.
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

// Editing a knowledge entry (PATCH /knowledge/entries/:id). refs/evidence are replaced WHOLE when given. status = an explicit transition such as deprecate or reactivate.
// Management is author-or-admin (the control plane).
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

// The "still valid" verification (POST /knowledge/entries/:id/verify) — it stamps verifiedAt alone and leaves updatedAt untouched (it is not an edit).
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

// Deleting a knowledge entry (DELETE /knowledge/entries/:id). Author-or-admin (the control plane).
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

// Approving a proposal (POST /knowledge/entries/:id/approve) — proposed→active plus transfer of authorship to the approver (the extraction provenance is kept for audit).
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

// Rejecting a proposal (POST /knowledge/entries/:id/reject) — the candidate is deleted. `proposed` only (anything else is a 409).
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
