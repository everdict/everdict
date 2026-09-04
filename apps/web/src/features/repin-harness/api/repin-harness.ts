'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RepinResult {
  ok: boolean
  version?: string
  error?: string
}

// Server action: headless re-pin. It resolves the harness's moving image bindings and registers the result
// as a NEW immutable instance version — it never edits the version in front of you, which is why the
// control plane answers with a version rather than a status.
export async function repinHarnessAction(id: string): Promise<RepinResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.repinHarness<{ version?: string }>(ctx, id)
    return { ok: true, ...(out.version ? { version: out.version } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
