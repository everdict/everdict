import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CapabilityDetailView, capKey } from '@/features/publish-capability'
// server-only 로더(controlPlane)라 클라이언트가 쓰는 배럴을 통하지 않고 직접 임포트한다(스토어 목록 페이지 선례).
import { loadStoreContext } from '@/features/publish-capability/api/store-context'
import { capabilitySchema, type Capability } from '@/entities/capability'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtSubject } from '@/shared/lib/format'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Store › 상세 — 발행 워크스페이스(source, 매니지드는 `_shared`)와 id 로 주소가 정해지는 한 항목의 전부.
// 상세는 언제나 라우트이지 다이얼로그가 아니다: 화면 절반을 덮는 모달이면 오른쪽 인프라/대화 패널에서 이 항목을 두고
// 실험할 수 없고, 링크로 공유할 수도 없다. `?from=mine` 은 내 발행 목록에서 들어온 진입 — 뒤로가기가 그리로 돌아가고
// 공개범위 배지를 함께 보여 준다(공개 카탈로그에서는 공개범위가 볼 것도 없이 전체공개다).
export default async function StoreCapabilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; source: string; id: string }>
  searchParams: Promise<{ from?: string }>
}) {
  const { workspace, source: rawSource, id: rawId } = await params
  const { from } = await searchParams
  const source = decodeURIComponent(rawSource)
  const id = decodeURIComponent(rawId)
  const t = await getTranslations('capabilityStore')
  const { principal, ctx } = await currentPrincipal()
  if (!can(principal?.roles, 'capabilities:read')) {
    return <EmptyState title={t('noPermissionTitle')} hint={t('noPermissionHint')} />
  }

  let capability: Capability
  try {
    capability = capabilitySchema.parse(
      await controlPlane.getCapability(ctx, id, undefined, source)
    )
  } catch {
    notFound() // 없거나 나에게 보이지 않는 발행물 — 존재 누설 없이 404(컨트롤플레인이 판정한다).
  }

  const store = await loadStoreContext(ctx)
  const currentWorkspace = principal?.workspace ?? workspace
  const variant = from === 'mine' ? 'mine' : 'catalog'
  const key = capKey(capability)
  const adoptedEnv = store.adoptedEnvironments.find((e) => `${e.source}/${e.id}` === key)
  // 이미 워크스페이스에 있는가 — 환경은 인벤토리, 스킬은 라이브러리 사본, 그 외는 에이전트 채택(목록의 판정과 동일).
  const inWorkspace =
    capability.spec.type === 'environment'
      ? adoptedEnv !== undefined
      : capability.spec.type === 'skill'
        ? store.importedSkillKeys.includes(key)
        : store.adoptedKeys.includes(key)
  const profile = store.authors[capability.createdBy]
  const author = {
    name: profile?.name ?? fmtSubject(capability.createdBy),
    ...(profile?.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  }

  return (
    <div className="space-y-6">
      <Link
        href={variant === 'mine' ? `/${workspace}/store/mine` : `/${workspace}/store`}
        className="inline-flex items-center gap-1 text-[13px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {t(variant === 'mine' ? 'backToMine' : 'backToStore')}
      </Link>
      <PageHeader title={capability.name} description={capability.description} />
      <CapabilityDetailView
        capability={capability}
        variant={variant}
        author={author}
        currentWorkspace={currentWorkspace}
        isAdmin={(principal?.roles ?? []).includes('admin')}
        inWorkspace={inWorkspace}
        {...(adoptedEnv ? { adoptedEnv } : {})}
        canAdopt={can(principal?.roles, 'agents:write')} // 채택 = 내 에이전트 설정 편집
        canImportEnvironment={can(principal?.roles, 'settings:write')} // 환경 = 워크스페이스 인벤토리
        canImportSkill={can(principal?.roles, 'skills:write')} // 스킬 = 라이브러리에 사본을 만드는 일
        secretNames={store.secretNames}
        {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
      />
    </div>
  )
}
