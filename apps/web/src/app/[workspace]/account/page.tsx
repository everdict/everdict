import { getTranslations } from 'next-intl/server'

import { apiKeysSchema, type ApiKeyMeta } from '@/entities/api-key'
import { secretsSchema, type SecretMeta } from '@/entities/secret'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { AccountTabs } from './account-tabs'

export const dynamic = 'force-dynamic'

// 유저 설정 페이지 — 프로필(수정) · 워크스페이스 나가기 · 개인 시크릿 · API 키(활성 워크스페이스).
// (외부 계정 연결은 워크스페이스 소유 GitHub App/Mattermost 로 대체 — 설정 › 통합에서 관리)
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const sp = await searchParams
  const t = await getTranslations('accountPage')
  const { principal, ctx } = await currentPrincipal()
  if (!principal) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('title')} description={t('descriptionSignedOut')} />
        <EmptyState title={t('signedOutTitle')} hint={t('signedOutHint')} />
      </div>
    )
  }

  // 개인 API 키 — self-scoped(역할 게이트 없음). GET /keys 는 본인(subject) 키만 돌려준다. 실패해도 페이지는 렌더.
  let keys: ApiKeyMeta[] = []
  let keysError: string | undefined
  try {
    keys = apiKeysSchema.parse(await controlPlane.listKeys(ctx))
  } catch (e) {
    keysError = e instanceof Error ? e.message : String(e)
  }

  // 내 개인(user) 시크릿 — GET /secrets 는 항상 본인 것만 포함(공유는 admin만). 셀프 관리라 역할 게이트 없음.
  let personalSecrets: SecretMeta[] = []
  try {
    personalSecrets = secretsSchema
      .parse(await controlPlane.listSecrets(ctx))
      .filter((s) => s.scope === 'user')
  } catch {
    // 시크릿 저장소 미설정/실패 — 빈 목록으로 폴백.
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <AccountTabs
        principal={principal}
        personalSecrets={personalSecrets}
        keys={keys}
        keysError={keysError}
        {...(sp.tab !== undefined ? { initialTab: sp.tab } : {})}
      />
    </div>
  )
}
