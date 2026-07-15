'use server'

import { revalidatePath } from 'next/cache'
import type { PortabilityIssue } from '@everdict/contracts/wire'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ValidateHarnessResult {
  ok: boolean
  errors?: string[]
  existingVersions?: string[]
  versionExists?: boolean
  id?: string
  version?: string
  kind?: string
  error?: string
  // Image provenance warning (warn-not-block) — local/unqualified images have no pull guarantee (registration still succeeds).
  imageWarnings?: { image: string; class: 'local' | 'unqualified' }[]
  // Cross-runtime portability findings on the service topology — anchored per service/field in the wizard. Template
  // validate returns these at authoring time (errors + warnings); the instance path folds errors into `errors` instead.
  portabilityIssues?: PortabilityIssue[]
}

export interface RegisterHarnessResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

// dry-run validation: schema + this workspace's existing versions/conflicts (does not register). The control plane enforces authZ/validation.
export async function validateHarnessAction(spec: unknown): Promise<ValidateHarnessResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateHarness<ValidateHarnessResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Register an instance (commit). Template existence + pins resolve / immutability (409) are enforced by the control plane (no gate, viewer+).
export async function registerHarnessAction(instance: unknown): Promise<RegisterHarnessResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.registerHarness<{ id: string; version: string }>(ctx, instance)
    revalidatePath('/[workspace]/harnesses')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Template (top-level category) dry-run validation — schema + existing versions (does not register).
export async function validateHarnessTemplateAction(spec: unknown): Promise<ValidateHarnessResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateHarnessTemplate<ValidateHarnessResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Template (top-level category) registration (commit). Immutability (409)/validation are enforced by the control plane (no gate, viewer+).
export async function registerHarnessTemplateAction(spec: unknown): Promise<RegisterHarnessResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.registerHarnessTemplate<{ id: string; version: string }>(
      ctx,
      spec
    )
    revalidatePath('/[workspace]/harnesses')
    revalidatePath('/[workspace]')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
