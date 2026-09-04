'use server'

import { saveModelResultSchema, testModelConnectionResultSchema } from '@/entities/model'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// A flat view of the connection test (dummy call) result — the UI uses only ok / the response text / the reason. A throw (network, 403) is absorbed as ok:false too.

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the DECLARATION
// alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface TestConnectionActionResult {
  ok: boolean
  text?: string
  error?: string
  latencyMs?: number
}

// Sends a minimal dummy call with the provider/model/baseUrl/apiKeySecret (a name) to see whether anything answers. A failure arrives as ok:false rather than a 4xx.
export async function testModelConnectionAction(
  connection: unknown
): Promise<TestConnectionActionResult> {
  const ctx = await authContext()
  try {
    const r = testModelConnectionResultSchema.parse(
      await controlPlane.testModelConnection(ctx, connection)
    )
    return r.ok ? { ok: true, text: r.text, latencyMs: r.latencyMs } : { ok: false, error: r.error }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface SaveModelActionResult {
  ok: boolean
  version?: string
  created?: boolean
  error?: string
}

// A versionless save (PUT /models/:id). A new id → 1.0.0, a changed connection → an automatic internal patch bump (a new immutable version), identical → an idempotent no-op.
// AuthZ (models:write) and version assignment are the control plane's.
export async function saveModelAction(id: string, body: unknown): Promise<SaveModelActionResult> {
  const ctx = await authContext()
  try {
    const r = saveModelResultSchema.parse(await controlPlane.saveModel(ctx, id, body))
    return { ok: true, version: r.version, created: r.created }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// A soft delete of the whole model (DELETE /models/:id with versions omitted = every live version this workspace owns). It is a TOMBSTONE, so past
// scorecards that referenced this model stay reproducible while later runs referencing it fail to resolve. AuthZ (registrant-or-admin) is enforced
// by the control plane — fail-fast (one forbidden or missing entry deletes nothing at all).
export async function deleteModelAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteModelVersions<{ deleted: string[] }>(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
