import { secretsSchema } from '@/entities/secret'
import { SecretsManager } from '@/features/manage-secrets'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function SecretsPage() {
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'secrets:read')
  const canWrite = can(principal?.roles, 'secrets:write')

  let error: string | undefined
  let storeDisabled = false
  let secrets = secretsSchema.parse([])
  if (canRead) {
    try {
      secrets = secretsSchema.parse(await controlPlane.listSecrets(ctx))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 컨트롤플레인에 ASSAY_SECRETS_KEY 미설정이면 /secrets 가 404(secret 저장소 미설정).
      if (msg.includes('→ 404') && msg.includes('미설정')) storeDisabled = true
      else error = msg
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="시크릿"
        description="이 워크스페이스의 모델/프로바이더 키와 클러스터 토큰. 값은 암호화 저장되고 실행 시점에만 잡 env 로 주입됩니다."
      />
      {!canRead ? (
        <EmptyState
          title="시크릿 조회 권한이 없습니다."
          hint="admin 역할이 필요합니다(secrets:read). 시크릿(키/토큰) 관리는 admin 전용입니다."
        />
      ) : storeDisabled ? (
        <Callout tone="danger">
          시크릿 저장소가 비활성화되어 있습니다. 컨트롤플레인에 <code>ASSAY_SECRETS_KEY</code>(base64
          32B) 를 설정해야 시크릿 기능이 켜집니다(미설정 시 fail-closed).
        </Callout>
      ) : error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : (
        <Card className="p-6">
          <SecretsManager secrets={secrets} canWrite={canWrite} />
        </Card>
      )}
    </div>
  )
}
