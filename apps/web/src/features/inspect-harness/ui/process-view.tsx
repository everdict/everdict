import { Cpu, ShieldCheck, Terminal } from 'lucide-react'

import type { HarnessSpec } from '@/entities/harness'
import { Card } from '@/shared/ui/card'

import { Field } from './parts'

// process 하니스 구성 — 단일 샌드박스 프로세스(Claude Code/Codex). 토폴로지/핀 대상 없음.
export function ProcessView({ spec }: { spec: HarnessSpec }) {
  return (
    <div className="space-y-6">
      <Card className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-primary/10 blur-3xl" />
        <div className="flex items-start gap-4 p-5">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/12 text-[var(--color-accent-foreground)] ring-1 ring-inset ring-primary/20">
            <Cpu className="size-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 space-y-1">
            <h3 className="text-[14px] font-[560] text-foreground">단일 프로세스 하니스</h3>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              격리된 샌드박스 1개 안에서 에이전트 CLI(Claude Code · Codex 등)를 직접 구동합니다.
              배포할 서비스 토폴로지나 핀할 슬롯이 없어 구조가 곧 버전입니다 — 비용/토큰은 하니스
              자체 트레이스에서 집계됩니다.
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-4 border-t border-border p-4">
          <Field label="종류" value={spec.kind} />
          <Field label="id" value={spec.id} />
          <Field label="버전" value={spec.version} />
        </dl>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCard
          icon={<Terminal className="size-4" />}
          title="구동 방식"
          body="LocalDriver 가 머신의 기존 로그인으로 하니스를 실행 — 별도 API 키 주입이 없습니다."
        />
        <InfoCard
          icon={<ShieldCheck className="size-4" />}
          title="격리"
          body="오케스트레이터(K8s Job / Nomad alloc)의 런타임이 격리 경계 — 프로세스는 그 안에서 동작합니다."
        />
      </div>
    </div>
  )
}

function InfoCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[13px] font-[560] text-foreground">{title}</span>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{body}</p>
    </Card>
  )
}
