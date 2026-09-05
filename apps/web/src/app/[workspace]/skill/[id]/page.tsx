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

// The author display (a member profile → name/avatar, falling back to an abbreviated subject).
function authorOf(members: Member[], subject: string): { name: string; avatarUrl?: string } {
  const member = members.find((m) => m.subject === subject)
  return {
    name: member?.name ?? member?.email?.split('@')[0] ?? fmtSubject(subject),
    ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
  }
}

// Workspace › Skills › detail — the SKILL.md body plus attached files plus the version line. **Only skills THIS workspace owns arrive here**:
// a store publication stands here under its own id from the moment "import" makes it a copy, and from then on it is indistinguishable from a
// hand-written skill (which is why the read-only ?source= branch is gone — a store item is viewed in the store).
// A detail is always a PAGE and never a dialog — you have to edit and experiment on this skill with the conversation panel on the right,
// which a modal covering half the screen makes impossible.
//
// The main editing path is "edit by conversation": it opens the conversation panel (if closed), drops an @-reference to this skill and frames
// the panel with the skillEdit mission — with NO prefilled prompt, because what to change is what the user says (the agent reviews and edits
// through get_skill/update_skill, under HITL approval). Once the result is right, "stamp a new version" fixes that content under a name.
// The manual edit dialog is the secondary path. A private skill 404s for anyone but its author (enforced by the control plane).
export default async function SkillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('skillsManager')
  const s = await getTranslations('settingsPage')
  const f = await getTranslations('files') // the body's file history speaks the Files vocabulary
  const { principal, ctx } = await currentPrincipal()
  if (!can(principal?.roles, 'skills:read')) {
    return <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
  }

  // The member profile for the author display — a soft failure (falling back to an abbreviated subject).
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  let skill: Skill
  try {
    skill = skillSchema.parse(await controlPlane.getSkill(ctx, id))
  } catch {
    notFound() // absent (another workspace included) or somebody else's private draft — a 404 that leaks no existence.
  }

  const isAdmin = (principal?.roles ?? []).includes('admin')
  const canManage =
    can(principal?.roles, 'skills:write') && (skill.createdBy === principal?.subject || isAdmin)
  // Whether public publishing to the store is possible — an admin, or the instance policy (GET /me's config.allowMemberPublicPublish).
  // UX gating only; the control plane (CapabilityService) enforces it finally.
  const canPublishPublic = isAdmin || principal?.config?.allowMemberPublicPublish === true

  const author = authorOf(members, skill.createdBy)

  // The stamped versions (newest first) — a soft failure: the skill body must still render even when the version line cannot be read.
  const versions = await controlPlane
    .listSkillVersions(ctx, id)
    .then((r) => skillVersionsSchema.parse(r))
    .catch(() => [])

  let modelIds: string[] = []
  try {
    modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
  } catch {
    // No registered model or no permission — only the edit dialog's AI wizard is disabled.
  }

  // There is one entry into the conversation panel, "edit by conversation" — it drops the reference chip and frames the panel with the
  // skillEdit mission (the same conversation structure, with that work's wording and suggestions). The app layer assembles the widget button and passes it to the feature.
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
