'use server'

import { getTranslations } from 'next-intl/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
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
