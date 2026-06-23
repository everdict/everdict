import type { ReactNode } from 'react'
import { ChevronRight, Container, Radio, SquareTerminal, Wrench } from 'lucide-react'

import type { HarnessSpec } from '@/entities/harness'

// command 하니스의 실행 흐름 도식: Sandbox(image) → Setup(설치) → Command(템플릿) → Trace(추출).
// 선언형 프로세스라 선형 — 측정 없이 가로 스테퍼로 그린다. 좁은 화면은 가로 스크롤.

// 명령 템플릿의 {{task}}/{{model}}/{{run_id}} 자리표시자를 강조 분리(순수).
function highlightTemplate(command: string): ReactNode[] {
  return command.split(/(\{\{[^}]+\}\})/g).map((part, i) =>
    /^\{\{[^}]+\}\}$/.test(part) ? (
      <span
        key={i}
        className="rounded bg-primary/15 px-1 text-[var(--color-accent-foreground)] ring-1 ring-inset ring-primary/25"
      >
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    )
  )
}

function Stage({
  icon,
  label,
  children,
  tone = 'neutral',
}: {
  icon: ReactNode
  label: string
  children: ReactNode
  tone?: 'neutral' | 'primary'
}) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-raise">
      <div className="flex items-center gap-1.5">
        <span
          className={
            tone === 'primary' ? 'text-[var(--color-accent-foreground)]' : 'text-muted-foreground'
          }
        >
          {icon}
        </span>
        <span className="text-[10.5px] font-[560] uppercase tracking-[0.12em] text-faint">
          {label}
        </span>
      </div>
      <div className="text-[12px] text-foreground">{children}</div>
    </div>
  )
}

function Arrow() {
  return (
    <div className="hidden shrink-0 items-center self-center text-faint sm:flex">
      <ChevronRight className="size-4" />
    </div>
  )
}

export function CommandPipeline({ spec }: { spec: HarnessSpec }) {
  const setup = spec.setup ?? []
  const trace = spec.trace?.kind ?? 'none'

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <Stage icon={<Container className="size-3.5" />} label="Sandbox">
          <div className="truncate font-mono text-[11.5px]" title={spec.image}>
            {spec.image ?? '기본 에이전트 이미지'}
          </div>
          {spec.workDir && (
            <div className="mt-1 font-mono text-[10.5px] text-muted-foreground">
              workdir {spec.workDir}
            </div>
          )}
        </Stage>
        <Arrow />
        <Stage icon={<Wrench className="size-3.5" />} label="Setup">
          {setup.length > 0 ? (
            <span className="tabular-nums">{setup.length}개 설치 단계</span>
          ) : (
            <span className="text-muted-foreground">설치 없음</span>
          )}
        </Stage>
        <Arrow />
        <Stage icon={<SquareTerminal className="size-3.5" />} label="Command" tone="primary">
          <div className="font-mono text-[11px] leading-relaxed">
            {spec.command ? highlightTemplate(spec.command.split(' ')[0] ?? spec.command) : '—'}
          </div>
          {spec.model && (
            <div className="mt-1 font-mono text-[10.5px] text-muted-foreground">
              model {spec.model}
            </div>
          )}
        </Stage>
        <Arrow />
        <Stage icon={<Radio className="size-3.5" />} label="Trace">
          {trace === 'none' ? (
            <span className="text-muted-foreground">결과만(트레이스 없음)</span>
          ) : (
            <span className="font-mono text-[11.5px]">{trace} pull</span>
          )}
        </Stage>
      </div>

      {/* 전체 명령 템플릿 */}
      {spec.command && (
        <div className="rounded-lg border border-border bg-[var(--color-muted)]/50 p-3.5">
          <div className="mb-2 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
            명령 템플릿
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-foreground">
            <span className="select-none text-faint">$ </span>
            {highlightTemplate(spec.command)}
          </pre>
        </div>
      )}
    </div>
  )
}
