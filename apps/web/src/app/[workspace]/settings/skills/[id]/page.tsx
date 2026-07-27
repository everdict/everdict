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
import { AskAgentButton } from '@/widgets/infra-panel'

export const dynamic = 'force-dynamic'

// Workspace › Skills › 상세 — SKILL.md 본문 + 부속 파일 열람. 편집의 주 경로는 "에이전트로 편집": 우측 대화 패널을
// 이 스킬 @참조 + 프리필 프롬프트로 열어, 에이전트가 get_skill/update_skill 로 검토·수정한다(HITL 승인). 수동 편집
// 다이얼로그는 보조 경로. 비공개 스킬은 작성자 외 404(컨트롤플레인이 강제).
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

  return (
    <div className="space-y-6">
      <PageHeader title={skill.name} description={skill.description} />
      <SkillDetail
        skill={skill}
        author={author}
        canManage={canManage}
        modelIds={modelIds}
        {...(canManage
          ? {
              agentAction: (
                <AskAgentButton
                  variant="primary"
                  label={t('editWithAgent')}
                  prompt={t('editWithAgentPrompt', { name: skill.name })}
                  reference={{ type: 'skill', id: skill.id, label: skill.name }}
                />
              ),
            }
          : {})}
      />
    </div>
  )
}
