import { ApiKeysManager } from '@/features/manage-api-keys'
import { apiKeysSchema, type ApiKeyMeta } from '@/entities/api-key'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { ThemeToggle } from '@/shared/ui/theme-toggle'

export const dynamic = 'force-dynamic'

// 유저 설정 페이지 — 프로필(읽기전용, GET /me) · 테마 · API 키(활성 워크스페이스, admin).
export default async function AccountPage() {
  const { principal, ctx } = await currentPrincipal()
  if (!principal) {
    return (
      <div className="space-y-6">
        <PageHeader title="계정" description="내 프로필과 API 키." />
        <EmptyState
          title="로그인이 필요합니다."
          hint="컨트롤플레인에서 신원을 확인할 수 없습니다."
        />
      </div>
    )
  }

  const canReadKeys = can(principal.roles, 'keys:read')
  const canWriteKeys = can(principal.roles, 'keys:write')

  let keys: ApiKeyMeta[] = []
  let keysError: string | undefined
  if (canReadKeys) {
    try {
      keys = apiKeysSchema.parse(await controlPlane.listKeys(ctx))
    } catch (e) {
      keysError = e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="계정" description="내 프로필 · 테마 · API 키." />

      <Card className="space-y-3 p-6">
        <h3 className="text-sm font-semibold">프로필</h3>
        <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">subject</dt>
          <dd className="truncate font-mono">{principal.subject}</dd>
          <dt className="text-muted-foreground">인증 방식</dt>
          <dd>{principal.via === 'oidc' ? 'Keycloak (OIDC)' : 'API 키'}</dd>
          <dt className="text-muted-foreground">활성 워크스페이스</dt>
          <dd className="font-mono">{principal.workspace || '—'}</dd>
          <dt className="text-muted-foreground">역할</dt>
          <dd>{principal.roles.join(', ') || '—'}</dd>
        </dl>
        {principal.workspaces && principal.workspaces.length > 0 && (
          <p className="text-sm">
            <span className="text-muted-foreground">내 워크스페이스: </span>
            {principal.workspaces.map((w) => `${w.name} (${w.role})`).join(', ')}
          </p>
        )}
      </Card>

      <Card className="space-y-3 p-6">
        <h3 className="text-sm font-semibold">테마</h3>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <ThemeToggle />
          <span>라이트/다크 모드 전환(이 브라우저에 저장).</span>
        </div>
      </Card>

      <Card className="p-6">
        {!canReadKeys ? (
          <EmptyState
            title="API 키 조회 권한이 없습니다."
            hint="admin 역할이 필요합니다(keys:read)."
          />
        ) : keysError ? (
          <Callout tone="danger">키 조회 실패: {keysError}</Callout>
        ) : (
          <ApiKeysManager keys={keys} canWrite={canWriteKeys} />
        )}
      </Card>
    </div>
  )
}
