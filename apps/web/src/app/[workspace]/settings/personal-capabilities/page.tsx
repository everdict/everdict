import { getTranslations } from 'next-intl/server'

import { SkillsManager } from '@/features/manage-skills'
import { CapabilityStore } from '@/features/publish-capability'
// server-only 로더(controlPlane)라 클라이언트가 쓰는 배럴을 통하지 않고 직접 임포트한다(download-desktop/api 선례).
import { loadStoreContext } from '@/features/publish-capability/api/store-context'
import { capabilitiesSchema, type Capability } from '@/entities/capability'
import { modelsSchema } from '@/entities/model'
import { skillsSchema, type Skill } from '@/entities/skill'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Account › My tools & skills — the user-private scope in one place: capabilities I published as
// visibility=private (only I see them) and my personal skill drafts (visibility=private living skills). Workspace-
// shared management lives in the workspace/agent settings; discovery of others' work lives in the store.
export default async function PersonalCapabilitiesPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const c = await getTranslations('capabilityStore')
  const { principal, ctx } = await currentPrincipal()
  const canReadCaps = can(principal?.roles, 'capabilities:read')
  const canWriteCaps = can(principal?.roles, 'capabilities:write')
  const canReadSkills = can(principal?.roles, 'skills:read')
  const canWriteSkills = can(principal?.roles, 'skills:write')
  const canAdopt = can(principal?.roles, 'agents:write')
  const canImportEnvironment = can(principal?.roles, 'settings:write')
  const isAdmin = (principal?.roles ?? []).includes('admin')
  const allowMemberPublicPublish = principal?.config?.allowMemberPublicPublish === true
  const currentWorkspace = principal?.workspace ?? ''
  const subject = principal?.subject
  const header = (
    <PageHeader title={t('personalCapabilities')} description={t('personalCapabilitiesDesc')} />
  )
  if (!canReadCaps && !canReadSkills) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let privateCaps: Capability[] = []
  let capsError: string | undefined
  if (canReadCaps) {
    try {
      // 내가 만든 비공개 발행물만 — visibility=private 는 생성자에게만 보이는 스코프.
      privateCaps = capabilitiesSchema
        .parse(await controlPlane.listCapabilities(ctx))
        .filter(
          (cap) =>
            cap.tenant === currentWorkspace &&
            cap.visibility === 'private' &&
            (subject === undefined || cap.createdBy === subject)
        )
    } catch (e) {
      capsError = e instanceof Error ? e.message : String(e)
    }
  }

  let personalSkills: Skill[] = []
  let skillsError: string | undefined
  if (canReadSkills) {
    try {
      // 개인 스킬 초안 — private living skill 은 생성자에게만 보인다(공유하면 워크스페이스 Skills 로 이동).
      personalSkills = skillsSchema
        .parse(await controlPlane.listSkills(ctx))
        .filter((skill) => skill.visibility === 'private')
    } catch (e) {
      skillsError = e instanceof Error ? e.message : String(e)
    }
  }

  // 스킬 생성 위저드 모델 피커 — 없으면 수동 폼만.
  let modelIds: string[] = []
  try {
    modelIds = modelsSchema.parse(await controlPlane.listModels(ctx)).map((m) => m.id)
  } catch {
    // no model registry / no permission — generation offers no model
  }
  const store = await loadStoreContext(ctx)

  return (
    <div className="space-y-8">
      {header}
      {canReadCaps && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">{c('personalCapsSection')}</h2>
            <p className="text-[12.5px] text-muted-foreground">{c('personalCapsHint')}</p>
          </div>
          {capsError !== undefined ? (
            <Callout tone="danger">{s('connectError', { error: capsError })}</Callout>
          ) : (
            <CapabilityStore
              items={privateCaps}
              variant="mine"
              authors={store.authors}
              canWrite={canWriteCaps}
              canAdopt={canAdopt}
              canImportEnvironment={canImportEnvironment}
              adoptedKeys={store.adoptedKeys}
              adoptedEnvironments={store.adoptedEnvironments}
              secretNames={store.secretNames}
              myWorkspaces={store.myWorkspaces}
              imageRegistries={store.imageRegistries}
              currentWorkspace={currentWorkspace}
              isAdmin={isAdmin}
              allowMemberPublicPublish={allowMemberPublicPublish}
              {...(subject !== undefined ? { currentSubject: subject } : {})}
            />
          )}
        </section>
      )}
      {canReadSkills && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">{c('personalSkillsSection')}</h2>
            <p className="text-[12.5px] text-muted-foreground">{c('personalSkillsHint')}</p>
          </div>
          {skillsError !== undefined ? (
            <Callout tone="danger">{s('connectError', { error: skillsError })}</Callout>
          ) : (
            <SkillsManager
              skills={personalSkills}
              modelIds={modelIds}
              authors={store.authors}
              canWrite={canWriteSkills}
              isAdmin={isAdmin}
              {...(subject !== undefined ? { currentSubject: subject } : {})}
            />
          )}
        </section>
      )}
    </div>
  )
}
