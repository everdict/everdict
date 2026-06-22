import { redirect } from 'next/navigation'
import { FlaskConical } from 'lucide-react'

import { AppShell } from '@/widgets/app-shell'
import { CreateWorkspaceForm } from '@/features/create-workspace'
import { currentPrincipal } from '@/shared/auth/principal'
import { keycloakConfigured } from '@/shared/config/env'
import { Card } from '@/shared/ui/card'

export const dynamic = 'force-dynamic'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { principal } = await currentPrincipal()

  // 로그인은 됐어도 컨트롤플레인과 인증 교환이 실패하면(GET /me 실패: 토큰 거부 401 / 컨트롤플레인 미가동)
  // 권위 있는 워크스페이스·역할이 없으므로 대시보드에 진입시키지 않고 홈으로 돌려보낸다.
  // (홈은 via!=='oidc'/principal=null 이면 랜딩을 보여줘 루프가 생기지 않는다.)
  if (!principal) redirect('/')

  // 로그인은 됐지만 아직 워크스페이스가 없으면(예: 외부 Keycloak — 토큰에 workspace 클레임/매퍼 없음) 온보딩:
  // 첫 워크스페이스를 만들면 그곳으로 전환되어 대시보드로 들어간다(Linear 식 첫 로그인 흐름).
  // dev 폴백/클레임 보유 사용자는 항상 ≥1 → 여기 안 걸림.
  if ((principal.workspaces?.length ?? 0) === 0) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.12)_inset,0_6px_18px_-6px_var(--primary)]">
            <FlaskConical className="size-[18px]" />
          </span>
          <span className="font-display text-[16px] font-[560] tracking-tight">Assay</span>
        </div>
        <div className="space-y-2">
          <h1 className="font-display text-[22px] font-[560] tracking-[-0.02em]">
            워크스페이스를 만들어 시작하세요
          </h1>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            환영합니다. 평가를 담을 워크스페이스가 아직 없습니다. 하나 만들면 바로 대시보드로
            들어갑니다.
          </p>
        </div>
        <Card className="p-5">
          <CreateWorkspaceForm />
        </Card>
      </main>
    )
  }

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
