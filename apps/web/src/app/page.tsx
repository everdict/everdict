import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowRight, FlaskConical, GitCompareArrows, Layers, ShieldCheck } from 'lucide-react'

import { currentPrincipal } from '@/shared/auth/principal'
import { Button } from '@/shared/ui/button'
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
  // 컨트롤플레인에 접속되고 실제 로그인(OIDC)이 확인되면 랜딩이 아니라 가장 최근 워크스페이스 대시보드로.
  // (활성 워크스페이스 쿠키 → /dashboard 가 GET /me 로 그 워크스페이스로 스코프한다.)
  // via!=='oidc'(dev x-assay-tenant 폴백)이거나 인증 교환 실패(principal=null)면 랜딩을 그대로 보여준다.
  const { principal } = await currentPrincipal()
  if (principal?.via === 'oidc') redirect('/dashboard')

  return (
    <main className="relative flex min-h-screen flex-col">
      {/* 상단 바 */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.12)_inset,0_6px_18px_-6px_var(--primary)]">
            <FlaskConical className="size-[18px]" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Assay</span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/api/auth/signin">
            <Button variant="ghost" size="sm">
              로그인
            </Button>
          </Link>
        </div>
      </header>

      {/* 히어로 */}
      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-7 px-6 py-20 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
          <span className="size-1.5 rounded-full bg-[var(--color-success)]" />
          Agent harness evaluation runtime
        </span>

        <h1 className="text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">
          하니스를 등록하고, 평가를 돌리고,
          <br className="hidden sm:block" />{' '}
          <span className="bg-gradient-to-r from-primary to-[var(--color-accent-foreground)] bg-clip-text text-transparent">
            테넌트별 스코어
          </span>
          를 본다.
        </h1>

        <p className="max-w-xl text-balance text-base leading-relaxed text-muted-foreground">
          Assay 는 어떤 에이전트 하니스든 환경·오케스트레이터에 무관하게 공정·격리·예산 하에
          평가하는 멀티테넌트 런타임입니다. 사람은 이 웹으로, 에이전트는 MCP 로 같은 플랫폼을
          씁니다.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link href="/dashboard">
            <Button className="gap-1.5">
              대시보드 열기
              <ArrowRight className="size-4" />
            </Button>
          </Link>
          <Link href="/api/auth/signin">
            <Button variant="outline">로그인</Button>
          </Link>
        </div>
      </section>

      {/* 피처 스트립 */}
      <section className="mx-auto grid w-full max-w-6xl gap-4 px-6 pb-24 sm:grid-cols-3">
        {FEATURES.map((f) => {
          const Icon = f.icon
          return (
            <div
              key={f.title}
              className="rounded-xl border bg-card/60 p-5 backdrop-blur transition-colors hover:border-[var(--color-muted-foreground)]/30"
            >
              <span className="mb-3 inline-grid size-9 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                <Icon className="size-[18px]" />
              </span>
              <h3 className="text-sm font-semibold tracking-tight">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          )
        })}
      </section>
    </main>
  )
}
