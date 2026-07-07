'use server'

import { revalidatePath } from 'next/cache'

import {
  ciLinksResponseSchema,
  reposSchema,
  setupPrResultSchema,
  type CiLink,
  type RepoInfo,
} from '@/entities/ci-link'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ReposResult {
  ok: boolean
  repos?: RepoInfo[]
  error?: string
}
export interface CiLinksResult {
  ok: boolean
  links?: CiLink[]
  error?: string
}
export interface SetupPrResult {
  ok: boolean
  prUrl?: string
  error?: string
}

// upsert 링크(레포↔하니스 슬롯) 입력 — dataset/slots/runsOn/runtime 은 선택. 컨트롤플레인이 최종 검증(admin 게이트).
export interface UpsertCiLinkInput {
  repository: string
  host?: string // GHE 베이스 URL(예: https://ghe.acme.io) — 미지정 = github.com
  harness: string
  dataset?: string
  slots?: Record<string, { path?: string }>
  runsOn?: string // 셀프호스티드 배치(선택) — 워크플로 runs-on
  runtime?: string // run-eval runtime 입력(예: self:ws:<id>)
  trigger?: 'auto' | 'comment' | 'both' // PR 평가 발화 방식 — 미지정 = both(자동 + /evaluate 코멘트)
}

// 레포 목록(picker) — 워크스페이스 GitHub App installation 이 접근 가능한 레포(설치 시 고른 것만). settings:read.
export async function listGithubAppReposAction(): Promise<ReposResult> {
  const ctx = await authContext()
  try {
    const repos = reposSchema.parse(await controlPlane.getGithubAppRepos(ctx))
    return { ok: true, repos }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 링크 저장(생성/갱신) — link 의 존재가 그 레포의 keyless CI 신뢰를 부여(settings:write=admin, 컨트롤플레인 강제).
export async function upsertCiLinkAction(input: UpsertCiLinkInput): Promise<CiLinksResult> {
  const ctx = await authContext()
  try {
    const { links } = ciLinksResponseSchema.parse(await controlPlane.upsertCiLink(ctx, input))
    revalidatePath('/[workspace]/harnesses/[id]', 'page')
    revalidatePath('/[workspace]/settings', 'page')
    return { ok: true, links }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 링크 해제(삭제) — settings:write(admin). host 미지정 = github.com link.
export async function deleteCiLinkAction(
  repository: string,
  host?: string
): Promise<CiLinksResult> {
  const ctx = await authContext()
  try {
    const { links } = ciLinksResponseSchema.parse(
      await controlPlane.deleteCiLink(ctx, repository, host)
    )
    revalidatePath('/[workspace]/harnesses/[id]', 'page')
    revalidatePath('/[workspace]/settings', 'page')
    return { ok: true, links }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 셋업 PR 열기 — link 의 워크플로 YAML 을 대상 레포에 PR(워크스페이스 GitHub App 토큰). harnesses:read(머지는 GitHub 쪽 승인).
export async function openSetupPrAction(repository: string, host?: string): Promise<SetupPrResult> {
  const ctx = await authContext()
  try {
    const { prUrl } = setupPrResultSchema.parse(
      await controlPlane.setupCiLinkPr(ctx, { repository, ...(host ? { host } : {}) })
    )
    return { ok: true, prUrl }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
