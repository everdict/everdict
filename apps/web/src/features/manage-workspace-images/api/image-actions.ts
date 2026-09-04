'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ImageActionResult {
  ok: boolean
  detail?: string
  error?: string
}

// Server action: copy an EXTERNAL image into this workspace's managed namespace. That copy is the
// provenance baseline a harness pin rests on — an image classified `external` is one nobody here can
// vouch for, and mirroring is how it stops being that.
export async function mirrorImageAction(image: string): Promise<ImageActionResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.mirrorWorkspaceImage<{ image?: string; copiedBlobs?: number }>(ctx, {
      image,
    })
    return { ok: true, ...(out.image ? { detail: out.image } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Server action: mint the push credential `everdict image push` consumes. A member who has to ask an agent
// for their own push credential is the gap this closes — but the secret itself is handed BACK to the caller
// and never stored by the web, which is why this returns it rather than persisting it anywhere.
export async function mintPushGrantAction(repository: string): Promise<ImageActionResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.mintImagePushGrant<{ token?: string; expiresAt?: string }>(ctx, repository)
    return {
      ok: true,
      ...(out.token ? { detail: out.token } : {}),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
