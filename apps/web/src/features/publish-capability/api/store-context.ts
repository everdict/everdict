import { agentSpecSchema } from '@/entities/agent-spec'
import {
  adoptedEnvironmentsResponseSchema,
  type AdoptedEnvironment,
} from '@/entities/environment-adoption'
import { imageRegistriesResponseSchema } from '@/entities/image-registry'
import { membersSchema } from '@/entities/member'
import { secretsSchema } from '@/entities/secret'
import { skillsSchema } from '@/entities/skill'
import { workspacesSchema } from '@/entities/workspace'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

export interface StoreContext {
  // 작성자 표시 — subject → 이름 + 아바타(멤버 프로필).
  authors: Record<string, { name: string; avatarUrl?: string }>
  // 이미 채택한 capability 키(source/id) — 행에 "채택됨" 표시.
  adoptedKeys: string[]
  // 이미 **가져온** 스킬 발행물의 출처 키(source/id) — 스킬은 채택 참조가 아니라 워크스페이스 스킬 **사본**이 되므로
  // "이미 있는가"는 라이브러리의 origin 으로 판정한다(카탈로그가 가져간 예제를 감추는 기준).
  importedSkillKeys: string[]
  // 워크스페이스가 가져온(import) 환경 이미지 인벤토리 — environment 의 "가져옴/사용가능" 표시용.
  adoptedEnvironments: AdoptedEnvironment[]
  // 채택 시 필요 시크릿을 바인딩할 후보(워크스페이스 시크릿 이름).
  secretNames: string[]
  // subset 공유 대상 피커용 — 내가 속한 워크스페이스(id + 이름).
  myWorkspaces: { id: string; name: string }[]
  // environment 이미지 태그 피커용 — 워크스페이스 레지스트리(이름 + host).
  imageRegistries: { name: string; host: string }[]
}

// 스토어(공개 카탈로그)·내 발행 페이지가 공통으로 쓰는 보조 데이터. 모두 소프트(실패해도 빈 값) — capability 목록만
// 있으면 페이지는 뜬다. 권한/주 목록은 각 페이지가 principal + 자기 소스로 로드하고, 여기서는 표시·채택 보조 데이터만 모은다.
export async function loadStoreContext(ctx: AuthContext): Promise<StoreContext> {
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

  const adoptedKeys = await controlPlane
    .getAgent(ctx, 'default', 'latest')
    .then((r) => agentSpecSchema.parse(r).capabilities.map((c) => `${c.source}/${c.id}`))
    .catch(() => [] as string[])

  const secretNames = await controlPlane
    .listSecrets(ctx)
    .then((r) =>
      secretsSchema
        .parse(r)
        .filter((secret) => secret.scope === 'workspace')
        .map((secret) => secret.name)
    )
    .catch(() => [] as string[])

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

  const importedSkillKeys = await controlPlane
    .listSkills(ctx)
    .then((r) =>
      skillsSchema
        .parse(r)
        .flatMap((skill) => (skill.origin ? [`${skill.origin.source}/${skill.origin.id}`] : []))
    )
    .catch(() => [] as string[])

  const adoptedEnvironments = await controlPlane
    .listAdoptedEnvironments(ctx)
    .then((r) => adoptedEnvironmentsResponseSchema.parse(r).environments)
    .catch(() => [] as AdoptedEnvironment[])

  return {
    authors,
    adoptedKeys,
    importedSkillKeys,
    adoptedEnvironments,
    secretNames,
    myWorkspaces,
    imageRegistries,
  }
}
