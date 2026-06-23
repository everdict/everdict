import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowRight, FlaskConical, GitCompareArrows, Layers, ShieldCheck } from 'lucide-react'

import { currentPrincipal } from '@/shared/auth/principal'
import { buttonVariants } from '@/shared/ui/button'
import { ThemeToggle } from '@/shared/ui/theme-toggle'

// 컨트롤플레인 GET /me 로 현재 인증을 확인해야 하므로 정적 렌더가 아니다.
export const dynamic = 'force-dynamic'

const FEATURES = [
  {
    icon: Layers,
    title: '하니스·환경 무관',
    body: 'Claude Code·Codex·LangGraph 등 어떤 에이전트 하니스든 repo/browser/os-use 환경에서 동일하게 평가.',
  },
  {
    icon: ShieldCheck,
    title: '격리·예산·공정성',
    body: '테넌트별 트러스트존 격리와 비용/런 예산, WFQ 스케줄링 위에서 안전하게 실행.',
  },
  {
    icon: GitCompareArrows,
    title: '버전 회귀 비교',
    body: '데이터셋×하니스 배치 평가를 스코어카드로 집계하고 baseline↔candidate 회귀를 한눈에.',
  },
] as const

export default async function Home() {
  // 컨트롤플레인에 접속되고 실제 로그인(OIDC)이 확인되면 랜딩이 아니라 내 워크스페이스(/{slug})로.
  // 워크스페이스가 0개면 온보딩으로. via!=='oidc'(dev x-assay-tenant 폴백)/principal=null 이면 랜딩을 보여준다.
  const { principal } = await currentPrincipal()
  const workspaceHome =
    principal && (principal.workspaces?.length ?? 0) > 0 ? `/${principal.workspace}` : '/onboarding'
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
              로그인
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
          하니스를 등록하고, 평가를 돌리고,
          <br className="hidden sm:block" /> <span className="text-primary">테넌트별 스코어</span>를
          본다.
        </h1>

        <p className="max-w-xl text-[15px] leading-relaxed text-balance text-muted-foreground">
          Assay 는 어떤 에이전트 하니스든 환경·오케스트레이터에 무관하게 공정·격리·예산 하에
          평가하는 멀티테넌트 런타임입니다. 사람은 이 웹으로, 에이전트는 MCP 로 같은 플랫폼을
          씁니다.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
          <Link href={enterHref} className={buttonVariants({ size: 'lg' })}>
            대시보드 열기
            <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/api/auth/signin"
            className={buttonVariants({ variant: 'secondary', size: 'lg' })}
          >
            로그인
          </Link>
        </div>
      </section>

      {/* 피처 스트립 */}
      <section className="mx-auto grid w-full max-w-5xl gap-4 px-6 pb-28 sm:grid-cols-3">
        {FEATURES.map((f) => {
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
