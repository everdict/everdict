import { getTranslations } from 'next-intl/server'

import { modelsSchema } from '@/entities/model'
import { type Skill, skillsSchema } from '@/entities/skill'
import { SkillsManager } from '@/features/manage-skills'
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

  let skills: Skill[] = []
  let error: string | undefined
  try {
    skills = skillsSchema.parse(await controlPlane.listSkills(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // Registered model ids power the skill-generate model picker.
  let modelIds: string[] = []
  try {
    modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
  } catch {
    // No model registry / no permission — generation offers no model (the manual form still works).
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <SkillsManager
          skills={skills}
          modelIds={modelIds}
          canWrite={canWrite}
          isAdmin={isAdmin}
          {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
        />
      )}
    </div>
  )
}
