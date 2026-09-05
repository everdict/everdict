'use server'

import { getTranslations } from 'next-intl/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the
// DECLARATION alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface ImportTerminalBenchInput {
  datasetId: string
  datasetVersion: string
  imageTemplate?: string
  tasksJson: string
}

export interface ImportTerminalBenchResult {
  ok: boolean
  id?: string
  version?: string
  cases?: number
  error?: string
}

// Server action: register a Terminal-Bench task set as a workspace dataset. The mapping (task → EvalCase) + the
// image-required rule are enforced by the control plane (an unresolved image is a 400). tasksJson is a JSON array of
// Terminal-Bench tasks ({id, instruction, image?, testCommand?, workdir?, difficulty?, tags?}).
export async function importTerminalBenchAction(
  input: ImportTerminalBenchInput
): Promise<ImportTerminalBenchResult> {
  const ctx = await authContext()
  const t = await getTranslations('datasetsPage')
  let tasks: unknown
  try {
    tasks = JSON.parse(input.tasksJson)
  } catch {
    return { ok: false, error: t('tbTasksParseError') }
  }
  const body = {
    dataset: { id: input.datasetId, version: input.datasetVersion || '1.0.0' },
    tasks,
    ...(input.imageTemplate?.trim() ? { imageTemplate: input.imageTemplate.trim() } : {}),
  }
  try {
    const rec = await controlPlane.importTerminalBench<{
      id: string
      version: string
      cases: number
    }>(ctx, body)
    return { ok: true, id: rec.id, version: rec.version, cases: rec.cases }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
