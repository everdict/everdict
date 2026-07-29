import { getTranslations } from 'next-intl/server'

import { SkillsManager } from '@/features/manage-skills'
import { agentSkillListSchema, type AgentSkillEntry } from '@/entities/agent-skill'
import { capabilitiesSchema, isBuiltInCapability, type Capability } from '@/entities/capability'
import { membersSchema } from '@/entities/member'
import { modelsSchema } from '@/entities/model'
import { skillsSchema, type Skill } from '@/entities/skill'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace › Skills — the SKILL.md library the members build up together for the conversational agent (author +
// generate + share). skills:read to view; skills:write to author/edit/share/delete (creator-or-admin per skill).
export default async function SkillsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'skills:read')
  const canWrite = can(principal?.roles, 'skills:write')
  const isAdmin = (principal?.roles ?? []).includes('admin')
  const header = <PageHeader title={t('skills')} description={t('skillsDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  // The workspace's shared skills + the caller's own private drafts — the control plane scopes the list, so both
  // scopes arrive in one call and the manager sections them.
  let skills: Skill[] = []
  let error: string | undefined
  try {
    skills = skillsSchema.parse(await controlPlane.listSkills(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // A skill is not only a Skill record authored here: a skill-kind CAPABILITY — one a member published to the store,
  // one shared into this workspace, or an Everdict built-in — is a `use_skill` entry for the agent all the same
  // (apps/agent merges the two by name when it resolves a turn's profile). Mirror that merge so this page is the whole
  // library the agent can draw on instead of half of it. Other workspaces' public skills stay in the store: they are
  // discovery, not library. Best-effort — capabilities being unreadable must not take the authored library down too.
  let packaged: Capability[] = []
  try {
    const [owned, builtIns] = await Promise.all([
      controlPlane.listCapabilities(ctx).then((r) => capabilitiesSchema.parse(r)),
      controlPlane.listPublicCapabilities(ctx).then((r) => capabilitiesSchema.parse(r)),
    ])
    // Name collisions resolve the way the agent resolves them: an authored Skill shadows a package, first package wins.
    const claimed = new Set(skills.map((s) => s.name))
    packaged = [...owned, ...builtIns.filter(isBuiltInCapability)].filter((c) => {
      if (c.spec.type !== 'skill' || claimed.has(c.name)) return false
      claimed.add(c.name)
      return true
    })
  } catch {
    packaged = []
  }

  // Registered model ids power the skill-generate model picker.
  let modelIds: string[] = []
  try {
    modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
  } catch {
    // No model registry / no permission — generation offers no model (the manual form still works).
  }

  // For showing who authored each skill — subject → name + avatar (if any). Name is profile name > email local part >
  // subject fallback. Soft: on fetch failure the list falls back to fmtSubject(createdBy).
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

  // 내 스킬셋 — 워크스페이스 라이브러리가 "지원하는 절차"라면 이건 "내 에이전트가 따르는 절차"(멤버별 오버레이).
  // 실패해도 라이브러리는 그대로 뜬다: 스위치만 빠진다.
  let agentSkills: AgentSkillEntry[] = []
  try {
    agentSkills = agentSkillListSchema.parse(await controlPlane.listAgentSkills(ctx)).skills
  } catch {
    agentSkills = []
  }

  return (
    <div className="space-y-6">
      {error !== undefined ? (
        <>
          {header}
          <Callout tone="danger">{s('connectError', { error })}</Callout>
        </>
      ) : (
        // Header is rendered inside the manager so the "New skill" button sits on the title row (PageHeader actions).
        <SkillsManager
          header={{ title: t('skills'), description: t('skillsDesc') }}
          skills={skills}
          packaged={packaged}
          agentSkills={agentSkills}
          currentWorkspace={principal?.workspace ?? ''}
          modelIds={modelIds}
          authors={authors}
          canWrite={canWrite}
          isAdmin={isAdmin}
          {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
        />
      )}
    </div>
  )
}
