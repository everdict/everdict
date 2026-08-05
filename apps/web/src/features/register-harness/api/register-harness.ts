'use server'

import type { PortabilityIssue } from '@everdict/contracts/wire'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface ValidateHarnessResult {
  ok: boolean
  errors?: string[]
  existingVersions?: string[]
  versionExists?: boolean
  id?: string
  version?: string
  kind?: string
  error?: string
  // Image provenance warning (warn-not-block) — local/unqualified images have no pull guarantee; mutable-tag images
  // (pinned by `latest`/untagged, no digest) are not reproducible. Registration still succeeds.
  imageWarnings?: { image: string; class: 'local' | 'unqualified' | 'mutable-tag' }[]
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
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
