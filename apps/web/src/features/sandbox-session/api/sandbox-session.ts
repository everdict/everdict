'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SandboxActionResult {
  ok: boolean
  detail?: string
  error?: string
}

// Keep-alive. A session dies on its deadline, and a person watching one could only watch it expire.
export async function touchSandboxAction(id: string): Promise<SandboxActionResult> {
  const ctx = await authContext()
  try {
    await controlPlane.touchSandbox(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Publish the session's filesystem as the WORLD's next version. The version it minted is the outcome — a
// snapshot that says only "done" leaves nobody able to reference what was just made.
export async function snapshotSandboxAction(id: string): Promise<SandboxActionResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.snapshotSandbox<{ version?: string }>(ctx, id)
    return { ok: true, ...(out.version ? { detail: out.version } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Push the working tree, optionally opening a pull request. The PR url comes back for the same reason the
// snapshot's version does: an outward effect nobody can find is one nobody can review.
export async function pushSandboxGitAction(
  id: string,
  pullRequest: boolean
): Promise<SandboxActionResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.pushSandboxGit<{ url?: string; branch?: string }>(ctx, id, { pullRequest })
    return { ok: true, ...(out.url ?? out.branch ? { detail: out.url ?? out.branch } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
