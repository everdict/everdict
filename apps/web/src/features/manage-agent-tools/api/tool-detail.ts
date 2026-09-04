'use server'

import { revalidatePath } from 'next/cache'

import {
  agentToolDetailSchema,
  agentToolProbeSchema,
  type AgentToolDetail,
  type AgentToolProbe,
} from '@/entities/agent-tool'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The tool detail screen's two actions — the connection test (probe) and secret binding. Failures come back as RESULTS (never thrown):
// "this tool does not reach ME" is the answer the user came to see, so the screen renders it inline.

export interface ProbeAgentToolResult {
  ok: boolean
  result?: AgentToolProbe
  error?: string
}

// The functions the server really offers at this moment — the only grounds against which the author's declared `provides` can be checked.
export async function probeAgentToolAction(key: string): Promise<ProbeAgentToolResult> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      result: agentToolProbeSchema.parse(await controlPlane.probeAgentTool(ctx, key)),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface BindAgentToolSecretsResult {
  ok: boolean
  tool?: AgentToolDetail
  error?: string
}

// A declared secret name → the real secret name. No value travels. It edits the workspace AgentSpec, so a new agent version is left behind.
export async function bindAgentToolSecretsAction(
  key: string,
  bindings: Record<string, string>
): Promise<BindAgentToolSecretsResult> {
  const ctx = await authContext()
  try {
    const tool = agentToolDetailSchema.parse(
      await controlPlane.bindAgentToolSecrets(ctx, key, bindings)
    )
    revalidatePath('/[workspace]/tools')
    revalidatePath('/[workspace]/tools/[key]')
    return { ok: true, tool }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
