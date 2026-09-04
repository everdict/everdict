import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { MentionInChatButton } from '@/widgets/infra-panel'
import { FileHistory } from '@/features/browse-files'
import { SkillDetail } from '@/features/manage-skills'
import { membersSchema, type Member } from '@/entities/member'
import { modelsSchema } from '@/entities/model'
import { skillSchema, skillVersionsSchema, type Skill } from '@/entities/skill'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtSubject } from '@/shared/lib/format'
import { EmptyState } from '@/shared/ui/empty-state'
import { VerifySkillButton } from '@/features/verify-skill'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 작성자 표시(멤버 프로필 → 이름/아바타, 실패 시 subject 축약).
function authorOf(members: Member[], subject: string): { name: string; avatarUrl?: string } {
  const member = members.find((m) => m.subject === subject)
  return {
    name: member?.name ?? member?.email?.split('@')[0] ?? fmtSubject(subject),
    ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
  }
}

// Workspace › Skills › 상세 — SKILL.md 본문 + 부속 파일 + 버전 라인. **이 워크스페이스가 소유한 스킬만 온다**:
// 스토어 발행물은 "가져오기"로 사본이 되는 순간부터 여기 자기 id 로 서고, 그때부터 직접 쓴 스킬과 구분이 없다
// (읽기 전용 ?source= 갈래는 그래서 사라졌다 — 스토어 것은 스토어에서 본다).
// 상세는 언제나 페이지이지 다이얼로그가 아니다 — 오른쪽 대화 패널에서 이 스킬을 두고 편집·실험해야 하므로
// 화면 절반을 덮는 모달이면 그 흐름 자체가 성립하지 않는다.
//
// 편집 주 경로는 "대화로 편집하기": 우측 대화 패널을 열고(닫혀 있으면) 이 스킬 @참조를 떨어뜨린 뒤 패널을
// skillEdit 임무로 프레이밍한다 — 프리필 프롬프트 없이, 무엇을 고칠지는 사용자가 말한다(에이전트가
// get_skill/update_skill 로 검토·수정, HITL 승인). 고친 결과가 마음에 들면 "새 버전 찍기"로 그 내용을 이름 붙여
// 고정한다. 수동 편집 다이얼로그는 보조 경로. 비공개 스킬은 작성자 외 404(컨트롤플레인이 강제).
export default async function SkillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('skillsManager')
  const s = await getTranslations('settingsPage')
  const f = await getTranslations('files') // the body's file history speaks the Files vocabulary
  const { principal, ctx } = await currentPrincipal()
  if (!can(principal?.roles, 'skills:read')) {
    return <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
  }

  // 작성자 표시용 멤버 프로필 — 소프트 실패(실패 시 subject 축약으로 폴백).
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

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

  // 찍힌 버전들(최신 우선) — 소프트 실패: 버전 라인을 못 읽어도 스킬 본문은 그대로 보여야 한다.
  const versions = await controlPlane
    .listSkillVersions(ctx, id)
    .then((r) => skillVersionsSchema.parse(r))
    .catch(() => [])

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
      <PageHeader
        title={skill.name}
        description={skill.description}
        actions={<VerifySkillButton id={id} />}
      />
      <SkillDetail
        skill={skill}
        author={author}
        versions={versions}
        canManage={canManage}
        canPublish={can(principal?.roles, 'capabilities:write')}
        canPublishPublic={canPublishPublic}
        modelIds={modelIds}
        actions={
          <MentionInChatButton reference={reference} label={t('editInChat')} mission="skillEdit" />
        }
      />
      {/* A skill's body IS a workspace file (skills/<id>/SKILL.md — the content-projection SSOT), so it carries
          the same publication history as any other file: edits from this page, from the Files shell and from
          agents all land in one list. Restoring here re-publishes the old body; the skill record re-syncs from
          the filesystem on its next read. */}
      <section className="space-y-2">
        <h2 className="text-[13.5px] font-[510] text-foreground">{f('historyTitle')}</h2>
        <p className="text-[12.5px] text-faint">{f('historyHint')}</p>
        <div className="overflow-hidden rounded-lg border border-border">
          <FileHistory path={`skills/${skill.id}/SKILL.md`} canWrite={canManage} />
        </div>
      </section>
    </div>
  )
}
