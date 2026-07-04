import { z } from 'zod'

// 컨트롤플레인 CI repo link(레포↔하니스 슬롯 매핑 = GitHub Actions OIDC trust policy)의 클라이언트 미러.
// 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존. 원본: packages/db WorkspaceCiLinkSchema.

// 슬롯 → 모노레포 path filter(선택). 이 레포의 CI 가 갈아끼우는 서비스 슬롯들.
export const ciLinkSlotSchema = z.object({ path: z.string().optional() })
export type CiLinkSlot = z.infer<typeof ciLinkSlotSchema>

// 한 레포 링크 — link 의 "존재"가 그 레포의 OIDC 토큰을 이 워크스페이스로 신뢰(keyless CI trust).
export const ciLinkSchema = z.object({
  repository: z.string(), // "owner/name"
  host: z.string().optional(), // 미지정 = github.com
  harness: z.string(), // 하니스 인스턴스 id
  dataset: z.string().optional(), // CI 가 발사할 데이터셋 id (setup-PR 워크플로 생성에 사용)
  slots: z.record(z.string(), ciLinkSlotSchema).default({}),
  createdBy: z.string(), // 감사용(발사 인증과 무관)
  disabled: z.boolean().optional(),
  runsOn: z.string().optional(), // 셀프호스티드 배치(선택) — 워크플로 runs-on 값(예: "[self-hosted, assay-<id>]")
  runtime: z.string().optional(), // run-eval runtime 입력(예: "self:ws:<id>") — 평가를 워크스페이스-공유 러너에서
})
export type CiLink = z.infer<typeof ciLinkSchema>

// GET/PUT/DELETE /workspace/ci/links 응답 — 항상 현재 링크 전체를 돌려준다.
export const ciLinksResponseSchema = z.object({ links: z.array(ciLinkSchema) })
export type CiLinksResponse = z.infer<typeof ciLinksResponseSchema>

// GET /connections/:id/repos 한 행 — GitHub 레포 목록(picker)을 얇게 정규화한 형태(bare array).
export const repoInfoSchema = z.object({
  fullName: z.string(), // "owner/name"
  private: z.boolean(),
  defaultBranch: z.string(),
  pushedAt: z.string().optional(),
})
export type RepoInfo = z.infer<typeof repoInfoSchema>
export const reposSchema = z.array(repoInfoSchema)

// POST /workspace/ci/links/setup-pr 응답 — 대상 레포에 연 워크플로 셋업 PR.
export const setupPrResultSchema = z.object({ prUrl: z.string(), branch: z.string() })
export type SetupPrResult = z.infer<typeof setupPrResultSchema>
