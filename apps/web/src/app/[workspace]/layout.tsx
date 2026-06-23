import { redirect } from 'next/navigation'

import { AppShell } from '@/widgets/app-shell'
import { currentPrincipal } from '@/shared/auth/principal'
import { keycloakConfigured } from '@/shared/config/env'

export const dynamic = 'force-dynamic'

// URL 첫 세그먼트가 활성 워크스페이스(Linear 식 /{workspace}/...). 미들웨어가 헤더로 주입하고
// currentPrincipal 이 그 워크스페이스로 스코프된 Principal 을 돌려준다. 이 레이아웃이 권위 있는 검증자다.
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ workspace: string }>
}) {
  const { workspace: slug } = await params
  const { principal } = await currentPrincipal()

  // 인증 교환 실패(토큰 거부 401 / 컨트롤플레인 미가동) → 권위 있는 워크스페이스·역할 없음 → 홈으로.
  // (홈은 via!=='oidc'/principal=null 이면 랜딩을 보여줘 루프가 생기지 않는다.)
  if (!principal) redirect('/')

  // 워크스페이스가 하나도 없으면 온보딩(첫 워크스페이스 생성). 앱은 항상 ≥1 워크스페이스 안에서 동작한다.
  if ((principal.workspaces?.length ?? 0) === 0) redirect('/onboarding')

  // URL 의 워크스페이스에 멤버가 아니면(오래된 링크/나간 워크스페이스 등) 내 기본 워크스페이스로.
  // (컨트롤플레인은 비멤버 선택을 기본으로 폴백시키므로 principal.workspace 는 항상 유효한 멤버십이다.)
  const isMember = principal.workspaces?.some((w) => w.id === slug) ?? false
  if (!isMember) redirect(`/${principal.workspace}`)

  return (
    <AppShell
      workspace={principal.workspace}
      workspaces={principal.workspaces ?? []}
      subject={principal.subject}
      roles={principal.roles}
      authed={principal.via === 'oidc'}
      showLogin={keycloakConfigured}
    >
      {children}
    </AppShell>
  )
}
