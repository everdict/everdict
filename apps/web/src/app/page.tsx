import Link from 'next/link'

import { Button } from '@/shared/ui/button'

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center">
      <span className="rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-foreground">
        Agent evaluation runtime
      </span>
      <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
        하니스를 등록하고, 평가를 돌리고, <span className="text-primary">테넌트별 스코어</span>를 본다.
      </h1>
      <p className="max-w-xl text-balance text-muted-foreground">
        Assay 는 어떤 에이전트 하니스든 환경·오케스트레이터에 무관하게 공정·격리·예산 하에 평가하는 멀티테넌트
        런타임입니다. 사람은 이 웹으로, 에이전트는 MCP 로 같은 플랫폼을 씁니다.
      </p>
      <div className="flex gap-3">
        <Link href="/dashboard">
          <Button>대시보드 열기</Button>
        </Link>
        <Link href="/api/auth/signin">
          <Button variant="secondary">로그인</Button>
        </Link>
      </div>
    </main>
  )
}
