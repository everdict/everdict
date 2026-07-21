'use server'

import { revalidatePath } from 'next/cache'

import {
  pairedRunnerSchema,
  pairRunnerInputSchema,
  type PairRunnerInput,
  type RunnerMeta,
} from '@/entities/runner'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { resolveRunnerApiUrl } from '@/shared/lib/runner-api-url'

export interface PairRunnerResult {
  ok: boolean
  token?: string // plaintext (rnr_…) — once only. Shown in the dialog then discarded, or handed down via the desktop bridge only.
  runner?: RunnerMeta // metadata for the just-paired runner — used when the desktop one-click passes runnerId to the bridge
  apiUrl?: string // control-plane base the runner connects to (not a secret) — for handing to the desktop bridge
  error?: string
}
export interface RunnerMutationResult {
  ok: boolean
  error?: string
}

// Device pairing — the control plane returns the rnr_… plaintext once (stored as a hash). Runners are personally owned (self-scoped by subject) — no role gate.
export async function pairRunnerAction(input: PairRunnerInput): Promise<PairRunnerResult> {
  const ctx = await authContext()
  try {
    // Boundary validation (the control plane re-enforces it, but bad input is filtered out here).
    const body = pairRunnerInputSchema.parse({
      label: input.label,
      ...(input.os && input.os.length > 0 ? { os: input.os } : {}),
      ...(input.capabilities && input.capabilities.length > 0
        ? { capabilities: input.capabilities }
        : {}),
    })
    const res = pairedRunnerSchema.parse(await controlPlane.pairRunner(ctx, body))
    revalidatePath('/[workspace]/runtimes')
    // The runner-reachable CP url (public/rebased), NOT the web's server-side CONTROL_PLANE_URL — a loopback there is
    // unreachable from a runner on another machine (the #1 "won't connect" cause). See resolveRunnerApiUrl.
    return { ok: true, token: res.token, runner: res.runner, apiUrl: await resolveRunnerApiUrl() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Revoke (delete) a runner. Runners are personally owned — you can only revoke your own (the control plane scopes by subject).
export async function revokeRunnerAction(id: string): Promise<RunnerMutationResult> {
  const ctx = await authContext()
  try {
    await controlPlane.revokeRunner(ctx, id)
    revalidatePath('/[workspace]/runtimes')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
