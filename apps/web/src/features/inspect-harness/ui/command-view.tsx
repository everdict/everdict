import { ListOrdered, Variable } from 'lucide-react'

import { envValueText, type HarnessSpec } from '@/entities/harness'
import { Card } from '@/shared/ui/card'

import { DefRow, highlightTemplate, Mono, SubSection } from './parts'

// command(선언형 CLI) 하니스 — 핵심 값(명령·모델·이미지·작업경로·트레이스)을 한 카드의 값 리스트로,
// 그 아래 Setup/환경변수는 있을 때만. 파이프라인 도식·중복 그리드는 제거(깔끔한 스캔 뷰).
export function CommandView({ spec }: { spec: HarnessSpec }) {
  const setup = spec.setup ?? []
  const env = spec.env ?? {}
  const envKeys = Object.keys(env)
  const trace = spec.trace

  return (
    <div className="space-y-6">
      {/* 화면이 넓을수록 열을 늘려 값을 넉넉히 펼친다. 명령은 길어서 전체 폭(col-span-full). */}
      <Card className="grid grid-cols-1 gap-x-10 gap-y-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        {spec.command && (
          <DefRow label="명령" wide>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12.5px] leading-relaxed text-foreground">
              <span className="select-none text-faint">$ </span>
              {highlightTemplate(spec.command)}
            </pre>
          </DefRow>
        )}
        <DefRow label="모델" mono>
          {spec.model ?? '—'}
        </DefRow>
        <DefRow label="이미지" mono>
          {spec.image ?? '기본 에이전트 이미지'}
        </DefRow>
        <DefRow label="작업 경로" mono>
          {spec.workDir ?? 'work'}
        </DefRow>
        {trace && trace.kind !== 'none' && (
          <DefRow label="트레이스" mono>
            {trace.kind} · pull{trace.endpoint ? ` · ${trace.endpoint}` : ''}
          </DefRow>
        )}
      </Card>

      {setup.length > 0 && (
        <SubSection title="Setup" icon={<ListOrdered className="size-4" />} count={setup.length}>
          <ol className="space-y-2">
            {setup.map((step, i) => (
              <li
                key={i}
                className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
              >
                <span className="mt-px grid size-5 shrink-0 place-items-center rounded bg-secondary font-mono text-[11px] tabular-nums text-muted-foreground ring-1 ring-inset ring-border">
                  {i + 1}
                </span>
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-foreground">
                  {step}
                </code>
              </li>
            ))}
          </ol>
        </SubSection>
      )}

      {envKeys.length > 0 && (
        <SubSection title="환경변수" icon={<Variable className="size-4" />} count={envKeys.length}>
          <Card className="divide-y divide-border">
            {envKeys.map((k) => (
              <div key={k} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <code className="font-mono text-[12px] text-foreground">{k}</code>
                <Mono>{envValueText(env[k])}</Mono>
              </div>
            ))}
          </Card>
        </SubSection>
      )}
    </div>
  )
}
