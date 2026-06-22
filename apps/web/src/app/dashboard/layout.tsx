import { FlaskConical } from 'lucide-react'

import { AppShell } from '@/widgets/app-shell'
import { CreateWorkspaceForm } from '@/features/create-workspace'
import { currentPrincipal } from '@/shared/auth/principal'
import { keycloakConfigured } from '@/shared/config/env'
import { Card } from '@/shared/ui/card'

export const dynamic = 'force-dynamic'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { principal } = await currentPrincipal()

  // 로그인은 됐지만 아직 워크스페이스가 없으면(예: 외부 Keycloak — 토큰에 workspace 클레임/매퍼 없음) 온보딩:
  // 첫 워크스페이스를 만들면 그곳으로 전환되어 대시보드로 들어간다(Linear 식 첫 로그인 흐름).
  // dev 폴백/클레임 보유 사용자는 항상 ≥1 → 여기 안 걸림. principal=null(컨트롤플레인 미가동)은 일반 셸로(에러 표시).
  if (principal && (principal.workspaces?.length ?? 0) === 0) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-6 py-16">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.12)_inset,0_6px_18px_-6px_var(--primary)]">
            <FlaskConical className="size-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">Assay</span>
        </div>
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">
            워크스페이스를 만들어 시작하세요
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            환영합니다. 평가를 담을 워크스페이스가 아직 없습니다. 하나 만들면 바로 대시보드로
            들어갑니다.
          </p>
        </div>
        <Card className="p-6">
          <CreateWorkspaceForm />
        </Card>
      </main>
    )
  }

  return (
    <AppShell
      workspace={principal?.workspace ?? '—'}
      workspaces={principal?.workspaces ?? []}
      roles={principal?.roles ?? []}
      authed={principal?.via === 'oidc'}
      showLogin={keycloakConfigured}
    >
      {children}
    </AppShell>
  )
}
