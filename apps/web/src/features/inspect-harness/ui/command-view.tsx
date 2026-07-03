import { ListOrdered, Radio, Settings2, Variable } from 'lucide-react'

import { envValueText, type HarnessSpec } from '@/entities/harness'
import { Card } from '@/shared/ui/card'

import { CommandPipeline } from './command-pipeline'
import { Field, Mono, SubSection } from './parts'

// command(선언형 CLI) 하니스 구성 — 파이프라인 도식 + setup/env/trace 상세.
export function CommandView({ spec }: { spec: HarnessSpec }) {
  const setup = spec.setup ?? []
  const env = spec.env ?? {}
  const envKeys = Object.keys(env)
  const trace = spec.trace

  return (
    <div className="space-y-7">
      <CommandPipeline spec={spec} />

      <Card>
        <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
          <Field label="이미지" value={spec.image ?? '기본'} />
          <Field label="작업 디렉터리" value={spec.workDir ?? 'work'} />
          <Field label="모델" value={spec.model ?? '—'} />
        </dl>
      </Card>

      <SubSection title="Setup" icon={<ListOrdered className="size-4" />} count={setup.length}>
        {setup.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            설치 단계 없음 — 이미지에 도구가 이미 포함.
          </p>
        ) : (
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
        )}
      </SubSection>

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

      <SubSection title="트레이스 추출" icon={<Radio className="size-4" />}>
        <Card>
          <dl className="grid grid-cols-2 gap-4 p-4">
            <Field label="종류" value={trace?.kind ?? 'none'} />
            {trace?.endpoint && <Field label="엔드포인트" value={trace.endpoint} />}
          </dl>
          {(!trace || trace.kind === 'none') && (
            <p className="border-t border-border px-4 py-2.5 text-[12px] text-muted-foreground">
              <Settings2 className="mr-1 inline size-3.5 align-text-bottom" />
              트레이스 없음 — 결과(파일 diff/종료코드)만으로 채점.
            </p>
          )}
        </Card>
      </SubSection>
    </div>
  )
}
