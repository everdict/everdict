'use server'

import {
  codeToolTryResultSchema,
  imageTagsSchema,
  imageVerifySchema,
  probeCapabilityMcpResultSchema,
  validateCapabilityResultSchema,
  type CapabilitySpec,
  type CodeToolTryResult,
  type ImageVerify,
  type ProbeCapabilityMcpResult,
  type ValidateCapabilityResult,
} from '@/entities/capability'
import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'
import { controlPlane } from '@/shared/lib/control-plane'

// The wizard's authoring-support server actions — pre-save validation, the mcp connection test (probe), and environment image tag lookup. A failure arrives as a RESULT
// (rather than throwing) — the form renders inline feedback.

export interface ValidateResult {
  ok: boolean
  result?: ValidateCapabilityResult
  error?: string
}

// The save dry-run — new capability or new version, the predicted version, plus (environment) image warnings. A spec parse failure is result.ok=false.
export async function validateCapabilityAction(
  id: string,
  name: string,
  description: string,
  spec: CapabilitySpec
): Promise<ValidateResult> {
  const ctx = await authContext()
  try {
    const result = validateCapabilityResultSchema.parse(
      await controlPlane.validateCapability(ctx, { id, name, description, spec })
    )
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ProbeResult {
  ok: boolean
  result?: ProbeCapabilityMcpResult
  error?: string
}

// The mcp URL connection test plus tool discovery. The token is a temporary test-only bearer (never stored).
export async function probeCapabilityMcpAction(url: string, token?: string): Promise<ProbeResult> {
  const ctx = await authContext()
  try {
    const result = probeCapabilityMcpResultSchema.parse(
      await controlPlane.probeCapabilityMcp(ctx, { url, ...(token ? { token } : {}) })
    )
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface TryCodeToolActionResult {
  ok: boolean
  result?: CodeToolTryResult
  error?: string
}

// Code tool verification (POST /agent/code-tools/try) — check = syntax only (a parse, no execution) · run = one real execution against the example input
// (the same execution contract as the agent; another workspace's code only in an isolated runtime — the gate is judged by the server from ownership).
// The wizard sends a draft spec and the store detail a published ref. Stateless.
export async function tryCodeToolAction(body: {
  mode: 'check' | 'run'
  name?: string
  spec?: CapabilitySpec
  ref?: { source: string; id: string; version: string }
  input?: Record<string, unknown>
}): Promise<TryCodeToolActionResult> {
  const ctx = await authContext()
  try {
    const result = codeToolTryResultSchema.parse(await agentPlane.tryCodeTool(ctx, body))
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ImageTagsResult {
  ok: boolean
  tags?: string[]
  error?: string
}

// The environment image picker — the repository tag list from the workspace registry (with several registered, the registry name is required).
export async function listImageTagsAction(
  repository: string,
  registry?: string
): Promise<ImageTagsResult> {
  const ctx = await authContext()
  try {
    const { tags } = imageTagsSchema.parse(
      await controlPlane.listImageTags(ctx, repository, registry)
    )
    return { ok: true, tags }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ImageVerifyResult {
  ok: boolean
  result?: ImageVerify
  error?: string
}

// A real pull verification at authoring time — the static classification warnings (imageWarnings) only ask "is it a registered registry", while
// this ASKS the registry (can the image I just pushed really be pulled). A digest that comes back is the reproducible pin.
export async function verifyImageAction(image: string): Promise<ImageVerifyResult> {
  const ctx = await authContext()
  try {
    const result = imageVerifySchema.parse(await controlPlane.verifyImage(ctx, image))
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
