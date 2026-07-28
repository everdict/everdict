import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { SkillDetail } from '@/features/manage-skills'
import { membersSchema } from '@/entities/member'
import { modelsSchema } from '@/entities/model'
import { skillSchema, type Skill } from '@/entities/skill'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { fmtSubject } from '@/shared/lib/format'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { MentionInChatButton } from '@/widgets/infra-panel'

export const dynamic = 'force-dynamic'

// Workspace › Skills › 상세 — SKILL.md 본문 + 부속 파일 열람. 편집의 주 경로는 "대화로 편집하기": 우측 대화 패널을
// 열고(닫혀 있으면) 이 스킬 @참조만 떨어뜨린다 — 프리필 프롬프트 없이, 무엇을 고칠지는 사용자가 말한다(에이전트가
// get_skill/update_skill 로 검토·수정, HITL 승인). 수동 편집 다이얼로그는 보조 경로. 비공개 스킬은 작성자 외
// 404(컨트롤플레인이 강제).
export default async function SkillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('skillsManager')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  if (!can(principal?.roles, 'skills:read')) {
    return <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
  }

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

  // 작성자 표시(멤버 프로필 → 이름/아바타, 실패 시 subject 축약) + 편집 다이얼로그의 생성 모델 목록. 둘 다 소프트 실패.
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const member = members.find((m) => m.subject === skill.createdBy)
  const author = {
    name: member?.name ?? member?.email?.split('@')[0] ?? fmtSubject(skill.createdBy),
    ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
  }
  let modelIds: string[] = []
  try {
    modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
  } catch {
    // 모델 미등록/권한 없음 — 편집 다이얼로그의 AI 위저드만 비활성.
  }

  // 대화 패널 진입은 "대화로 편집하기" 하나 — 참조 칩만 떨어뜨린다. 위젯 버튼은 앱 레이어가 조립해 feature 에 내려준다.
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
        actions={<MentionInChatButton reference={reference} label={t('editInChat')} />}
      />
    </div>
  )
}
