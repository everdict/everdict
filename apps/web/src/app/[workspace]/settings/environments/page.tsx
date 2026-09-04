import { getTranslations } from 'next-intl/server'

// server-only 로더(controlPlane)라 클라이언트가 쓰는 배럴을 통하지 않고 직접 임포트한다(download-desktop/api 선례).
import { loadEnvironmentContext } from '@/features/publish-capability/api/environment-context'
import { capabilitiesSchema, type Capability } from '@/entities/capability'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { SettingsEnvironments } from './settings-environments'
import { EnvironmentRegistry, loadEnvironments } from '@/features/browse-environments'

export const dynamic = 'force-dynamic'

// Settings › Workspace › Environments — 이 워크스페이스가 쓸 수 있는 평가환경을 한 목록으로: 직접 저작한 환경
// (등록/공유/버전)과 스토어에서 가져온 환경(풀 가능 검증)을 환경의 어휘로 관리한다. 남의 발행물 발견·가져오기는
// 스토어(카탈로그)가 담당 — 여기서는 링크만 건다.
export default async function EnvironmentsSettingsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const tEnv = await getTranslations('settingsEnvironments')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'capabilities:read')
  const canWrite = can(principal?.roles, 'capabilities:write')
  const canImport = can(principal?.roles, 'settings:write')
  const isAdmin = (principal?.roles ?? []).includes('admin')
  const canPublishPublic = isAdmin || principal?.config?.allowMemberPublicPublish === true
  const currentWorkspace = principal?.workspace ?? ''
  const header = <PageHeader title={t('environments')} description={t('environmentsDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let authored: Capability[] = []
  let error: string | undefined
  try {
    // 내 워크스페이스가 저작·소유한 환경 이미지만 — 남의 발행물은 스토어(카탈로그)에서 브라우즈·가져오기 한다.
    authored = capabilitiesSchema
      .parse(await controlPlane.listCapabilities(ctx))
      .filter((cap) => cap.tenant === currentWorkspace && cap.spec.type === 'environment')
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const context = await loadEnvironmentContext(ctx)
  // The registry read is carried as a VALUE — a failure here must not take the image list above down.
  const registry = await loadEnvironments(ctx)

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <SettingsEnvironments
          authored={authored}
          imported={context.adoptedEnvironments}
          authors={context.authors}
          currentWorkspace={currentWorkspace}
          isAdmin={isAdmin}
          canWrite={canWrite}
          canImport={canImport}
          canPublishPublic={canPublishPublic}
          myWorkspaces={context.myWorkspaces}
          imageRegistries={context.imageRegistries}
          {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
        />
      )}

      {/* …and the registry itself — the entity a case points at with `env: {kind: "ref"}` and a batch seals
          the resolved version of. The imported environments above are IMAGES (bytes); this is the world
          those bytes make, and only the second is an identity axis a batch can seal. Two pages would make a
          reader memorise which one holds which noun. */}
      <div className="border-t pt-6">
        <h2 className="mb-3 text-[11px] font-[510] uppercase tracking-wide text-faint">
          {tEnv('registryHeading')}
        </h2>
        <EnvironmentRegistry
          {...(registry.list ? { list: registry.list } : {})}
          {...(registry.error !== undefined ? { error: registry.error } : {})}
          canTag={canWrite}
        />
      </div>
    </div>
  )
}
