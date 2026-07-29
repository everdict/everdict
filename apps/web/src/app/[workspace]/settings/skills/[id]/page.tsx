import { notFound } from 'next/navigation'
import { FileText, Package } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { MentionInChatButton } from '@/widgets/infra-panel'
import { SkillDetail } from '@/features/manage-skills'
import { capabilitiesSchema, isBuiltInCapability, type Capability } from '@/entities/capability'
import { membersSchema, type Member } from '@/entities/member'
import { modelsSchema } from '@/entities/model'
import { skillSchema, type Skill } from '@/entities/skill'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtSubject } from '@/shared/lib/format'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SkillDocs } from '@/shared/ui/skill-docs'

export const dynamic = 'force-dynamic'

// 작성자 표시(멤버 프로필 → 이름/아바타, 실패 시 subject 축약).
function authorOf(members: Member[], subject: string): { name: string; avatarUrl?: string } {
  const member = members.find((m) => m.subject === subject)
  return {
    name: member?.name ?? member?.email?.split('@')[0] ?? fmtSubject(subject),
    ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
  }
}

// Workspace › Skills › 상세 — SKILL.md 본문 + 부속 파일 열람. **라이브러리의 모든 스킬이 이 한 라우트로 온다**:
// 저작 Skill 레코드는 id 로, 스토어 발행물/빌트인(스킬 kind capability)은 `?source=<소유 워크스페이스>` 로.
// 상세는 언제나 페이지이지 다이얼로그가 아니다 — 오른쪽 대화 패널에서 이 스킬을 두고 편집·실험해야 하므로
// 화면 절반을 덮는 모달이면 그 흐름 자체가 성립하지 않는다.
//
// 저작 스킬의 편집 주 경로는 "대화로 편집하기": 우측 대화 패널을 열고(닫혀 있으면) 이 스킬 @참조를 떨어뜨린 뒤
// 패널을 skillEdit 임무로 프레이밍한다 — 프리필 프롬프트 없이, 무엇을 고칠지는 사용자가 말한다(에이전트가
// get_skill/update_skill 로 검토·수정, HITL 승인). 수동 편집 다이얼로그는 보조 경로. 비공개 스킬은 작성자 외
// 404(컨트롤플레인이 강제). 발행물은 여기서 고칠 수 없다(저작·버전은 스토어 소관) — 읽기 전용 문서만.
export default async function SkillDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ source?: string }>
}) {
  const { id } = await params
  const { source } = await searchParams
  const t = await getTranslations('skillsManager')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  if (!can(principal?.roles, 'skills:read')) {
    return <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
  }

  // 작성자 표시용 멤버 프로필 — 두 갈래 공통, 소프트 실패(실패 시 subject 축약으로 폴백).
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  // ── 패키지 스킬(발행물/빌트인) ─────────────────────────────────────────────────────────────────
  // 빌트인은 컨트롤플레인 store 에 행이 아니라 코드 정의물이라 GET /capabilities/:id 로 잡히지 않는다 —
  // 목록(내 소유 + 공개 카탈로그)에서 (tenant, id) 로 찾는다. 목록 화면이 쓰는 병합과 같은 소스.
  if (source !== undefined) {
    let capability: Capability | undefined
    try {
      const [owned, publics] = await Promise.all([
        controlPlane.listCapabilities(ctx).then((r) => capabilitiesSchema.parse(r)),
        controlPlane.listPublicCapabilities(ctx).then((r) => capabilitiesSchema.parse(r)),
      ])
      capability = [...owned, ...publics].find(
        (c) => c.id === id && c.tenant === source && c.spec.type === 'skill'
      )
    } catch {
      capability = undefined
    }
    if (!capability || capability.spec.type !== 'skill') notFound()
    const spec = capability.spec
    const author = authorOf(members, capability.createdBy)
    const builtIn = isBuiltInCapability(capability)
    return (
      <div className="space-y-6">
        <PageHeader title={capability.name} description={capability.description} />
        <div className="space-y-4">
          {/* 메타 스트립 — 출처(빌트인/발행물) · 버전 · 작성자 · 파일 수. 저작 스킬 상세와 같은 문법. */}
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            <Badge tone={builtIn ? 'info' : 'outline'} className="gap-1">
              <Package className="size-3" />
              {builtIn ? t('builtInBadge') : t('packagedBadge')}
            </Badge>
            <Badge tone="outline" className="font-mono">
              v{capability.version}
            </Badge>
            <span className="inline-flex items-center gap-1.5">
              <Avatar
                name={author.name}
                url={author.avatarUrl}
                size="sm"
                className="rounded-full"
              />
              {t('createdBy', { name: author.name })}
            </span>
            {spec.files.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <FileText className="size-3.5" />
                {t('fileCount', { count: spec.files.length })}
              </span>
            )}
          </div>
          <p className="text-[12.5px] text-faint">
            {builtIn ? t('builtInHint') : t('packagedHint')}
          </p>
          <SkillDocs instructions={spec.instructions} files={spec.files} />
        </div>
      </div>
    )
  }

  // ── 이 워크스페이스에서 저작한 Skill 레코드 ────────────────────────────────────────────────────
  let skill: Skill
  try {
    skill = skillSchema.parse(await controlPlane.getSkill(ctx, id))
  } catch {
    notFound() // 없거나(타 워크스페이스 포함) 남의 비공개 초안 — 존재 누설 없이 404.
  }

  const isAdmin = (principal?.roles ?? []).includes('admin')
  const canManage =
    can(principal?.roles, 'skills:write') && (skill.createdBy === principal?.subject || isAdmin)
  // 스토어 public 발행 가능 여부 — admin 또는 인스턴스 정책(GET /me 의 config.allowMemberPublicPublish).
  // UX 게이팅용일 뿐 최종 강제는 컨트롤플레인(CapabilityService).
  const canPublishPublic = isAdmin || principal?.config?.allowMemberPublicPublish === true

  const author = authorOf(members, skill.createdBy)
  let modelIds: string[] = []
  try {
    modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
  } catch {
    // 모델 미등록/권한 없음 — 편집 다이얼로그의 AI 위저드만 비활성.
  }

  // 대화 패널 진입은 "대화로 편집하기" 하나 — 참조 칩을 떨어뜨리고 패널을 skillEdit 임무로 프레이밍한다(같은
  // 대화 구조에 그 작업의 문구·제안). 위젯 버튼은 앱 레이어가 조립해 feature 에 내려준다.
  const reference = { type: 'skill' as const, id: skill.id, label: skill.name }
  return (
    <div className="space-y-6">
      <PageHeader title={skill.name} description={skill.description} />
      <SkillDetail
        skill={skill}
        author={author}
        canManage={canManage}
        canPublish={can(principal?.roles, 'capabilities:write')}
        canPublishPublic={canPublishPublic}
        modelIds={modelIds}
        actions={
          <MentionInChatButton reference={reference} label={t('editInChat')} mission="skillEdit" />
        }
      />
    </div>
  )
}
