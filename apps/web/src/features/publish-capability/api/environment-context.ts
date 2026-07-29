import {
  adoptedEnvironmentsResponseSchema,
  type AdoptedEnvironment,
} from '@/entities/environment-adoption'
import { imageRegistriesResponseSchema } from '@/entities/image-registry'
import { membersSchema } from '@/entities/member'
import { workspacesSchema } from '@/entities/workspace'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

export interface EnvironmentContext {
  // 작성자 표시 — subject → 이름 + 아바타(멤버 프로필).
  authors: Record<string, { name: string; avatarUrl?: string }>
  // 워크스페이스가 가져온(import) 환경 이미지 인벤토리 — 통합 목록의 "가져옴/풀 가능" 행.
  adoptedEnvironments: AdoptedEnvironment[]
  // subset 공유 대상 피커용 — 내가 속한 워크스페이스(id + 이름).
  myWorkspaces: { id: string; name: string }[]
  // 이미지 태그 도우미용 — 워크스페이스 레지스트리(이름 + host).
  imageRegistries: { name: string; host: string }[]
}

// Settings › Environments 보조 데이터 — 스토어 컨텍스트(loadStoreContext)에서 환경 표면이 실제로 쓰는
// 것만 추린 로더(에이전트 채택 키·시크릿 이름은 환경과 무관). 전부 소프트(실패해도 빈 값).
export async function loadEnvironmentContext(ctx: AuthContext): Promise<EnvironmentContext> {
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const adoptedEnvironments = await controlPlane
    .listAdoptedEnvironments(ctx)
    .then((r) => adoptedEnvironmentsResponseSchema.parse(r).environments)
    .catch(() => [] as AdoptedEnvironment[])

  const myWorkspaces = await controlPlane
    .listWorkspaces(ctx)
    .then((r) => workspacesSchema.parse(r).map((w) => ({ id: w.id, name: w.name })))
    .catch(() => [] as { id: string; name: string }[])

  const imageRegistries = await controlPlane
    .listImageRegistries(ctx)
    .then((r) =>
      imageRegistriesResponseSchema
        .parse(r)
        .registries.map((reg) => ({ name: reg.name, host: reg.host }))
    )
    .catch(() => [] as { name: string; host: string }[])

  return { authors, adoptedEnvironments, myWorkspaces, imageRegistries }
}
