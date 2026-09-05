'use server'

import { revalidatePath } from 'next/cache'

import {
  capabilitySchema,
  saveCapabilityResultSchema,
  type Capability,
  type CapabilitySpec,
  type CapabilityVisibility,
  type SaveCapabilityResult,
} from '@/entities/capability'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Every surface that renders a capability list — the store (the catalog and my publications) and the settings management pages (tools/environments/my tools and skills).
function revalidateCapabilityPages(): void {
  for (const path of [
    '/[workspace]/store',
    '/[workspace]/store/mine',
    '/[workspace]/tools',
    '/[workspace]/settings/environments',
  ])
    revalidatePath(path)
}

export interface SaveCapabilityInput {
  name: string
  description: string
  spec: CapabilitySpec
  visibility?: CapabilityVisibility
  sharedWith?: string[]
  tags?: string[]
}

export interface SaveCapabilityActionResult {
  ok: boolean
  result?: SaveCapabilityResult
  error?: string
}

// Publishing or editing a capability (PUT /capabilities/:id) — a versionless upsert (a new id → 1.0.0, changed content → a patch bump). Owner-or-admin;
// publishing public is admin (enforced by the control plane). visibility/sharedWith are set at CREATION only; an edit inherits the current reach.
export async function saveCapabilityAction(
  id: string,
  body: SaveCapabilityInput
): Promise<SaveCapabilityActionResult> {
  const ctx = await authContext()
  try {
    const result = saveCapabilityResultSchema.parse(
      await controlPlane.saveCapability(ctx, id, body)
    )
    revalidateCapabilityPages()
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface CapabilityActionResult {
  ok: boolean
  capability?: Capability
  error?: string
}

// Changing a capability's visibility (PATCH /capabilities/:id/visibility) — it cuts through every live version. Owner-or-admin, and public is admin.
export async function setCapabilityVisibilityAction(
  id: string,
  body: { visibility: CapabilityVisibility; sharedWith: string[] }
): Promise<CapabilityActionResult> {
  const ctx = await authContext()
  try {
    const capability = capabilitySchema.parse(
      await controlPlane.setCapabilityVisibility(ctx, id, body)
    )
    revalidateCapabilityPages()
    return { ok: true, capability }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Deleting a capability version (DELETE /capabilities/:id/versions/:version) — the version's author-or-admin (the control plane).
export async function deleteCapabilityVersionAction(
  id: string,
  version: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteCapabilityVersion(ctx, id, version)
    revalidateCapabilityPages()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
