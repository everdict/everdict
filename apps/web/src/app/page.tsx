import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowRight, FlaskConical, GitCompareArrows, Layers, ShieldCheck } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { currentPrincipal } from '@/shared/auth/principal'
import { buttonVariants } from '@/shared/ui/button'
import { ThemeToggle } from '@/shared/ui/theme-toggle'

// 컨트롤플레인 GET /me 로 현재 인증을 확인해야 하므로 정적 렌더가 아니다.
export const dynamic = 'force-dynamic'

export default async function Home() {
  const t = await getTranslations('landingPage')
  const features = [
    { icon: Layers, title: t('featureAnyAgentTitle'), body: t('featureAnyAgentBody') },
    { icon: ShieldCheck, title: t('featureSafeTitle'), body: t('featureSafeBody') },
    { icon: GitCompareArrows, title: t('featureCompareTitle'), body: t('featureCompareBody') },
  ] as const
  // 컨트롤플레인에 접속되고 실제 로그인(OIDC)이 확인되면 랜딩이 아니라 내 워크스페이스(/{slug})로.
  // 워크스페이스가 0개면 온보딩으로. via!=='oidc'(dev x-assay-tenant 폴백)/principal=null 이면 랜딩을 보여준다.
  const { principal } = await currentPrincipal()
  // 활성 워크스페이스가 비어 있으면(예: keycloak 토큰에 workspace 클레임 없음) 내 첫 워크스페이스로 폴백.
  // principal.workspace 가 "" 면 `/${""}` = "/" 가 되어 이 페이지로 다시 튕기는 무한 루프가 나므로 그대로 쓰지 않는다.
  const activeWorkspace = principal
    ? principal.workspace || principal.workspaces?.[0]?.id
    : undefined
  const workspaceHome = activeWorkspace ? `/${activeWorkspace}` : '/onboarding'
  if (principal?.via === 'oidc') redirect(workspaceHome)

  // 랜딩의 진입 CTA: dev 폴백 등으로 principal 이 있으면 워크스페이스로, 없으면 로그인으로.
  const enterHref = principal ? workspaceHome : '/api/auth/signin'

  return (
    <main className="relative flex min-h-screen flex-col">
      {/* 상단 바 — 절제된 워드마크 + 테마/로그인 */}
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.12)_inset,0_6px_18px_-6px_var(--primary)]">
              <FlaskConical className="size-4" />
            </span>
            <span className="font-display text-[15px] font-[560] tracking-tight">Assay</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ThemeToggle />
            <Link
              href="/api/auth/signin"
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              {t('login')}
            </Link>
          </div>
        </div>
      </header>

      {/* 히어로 — 랜딩만 넉넉한 여백이 정답 */}
      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-8 px-6 py-24 text-center sm:py-32">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-[12px] font-[510] text-muted-foreground shadow-raise">
          <span className="size-1.5 rounded-full bg-[var(--color-success)]" />
          Agent harness evaluation runtime
        </span>

        <h1 className="font-display text-5xl font-[560] leading-[1.06] tracking-[-0.025em] text-balance break-keep sm:text-6xl">
          {t.rich('heroTitle', {
            br: () => <br className="hidden sm:block" />,
            highlight: (chunks) => <span className="text-primary">{chunks}</span>,
          })}
        </h1>

        <p className="max-w-xl text-[15px] leading-relaxed text-balance text-muted-foreground">
          {t('heroSubtitle')}
        </p>

        <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
          <Link href={enterHref} className={buttonVariants({ size: 'lg' })}>
            {t('openDashboard')}
            <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/api/auth/signin"
            className={buttonVariants({ variant: 'secondary', size: 'lg' })}
          >
            {t('login')}
          </Link>
        </div>
      </section>

      {/* 피처 스트립 */}
      <section className="mx-auto grid w-full max-w-5xl gap-4 px-6 pb-28 sm:grid-cols-3">
        {features.map((f) => {
          const Icon = f.icon
          return (
            <div
              key={f.title}
              className="rounded-xl border bg-card p-5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <span className="mb-4 inline-grid size-9 place-items-center rounded-lg bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                <Icon className="size-[18px]" strokeWidth={1.75} />
              </span>
              <h3 className="text-[14px] font-[560] tracking-tight text-foreground">{f.title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          )
        })}
      </section>
    </main>
  )
}
