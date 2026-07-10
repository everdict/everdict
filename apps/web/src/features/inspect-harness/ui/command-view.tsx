import { ListOrdered, Variable } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { envValueText, type HarnessSpec } from '@/entities/harness'
import { Card } from '@/shared/ui/card'

import { DefRow, highlightTemplate, ImageClassBadge, Mono, SubSection } from './parts'

// command (declarative CLI) harness — the core values (command·model·image·working path·trace) as one card's value list,
// with Setup/env vars below only when present. The pipeline diagram and duplicate grid are dropped (a clean scan view).
// The provenance-classification badge reads the served spec.imageClasses (P1g) — no client-side classification.
export function CommandView({ spec }: { spec: HarnessSpec }) {
  const t = useTranslations('inspectHarness')
  const setup = spec.setup ?? []
  const env = spec.env ?? {}
  const envKeys = Object.keys(env)
  const trace = spec.trace

  return (
    <div className="space-y-6">
      {/* The wider the screen, the more columns, so values spread out generously. The command is long, so it spans full width (col-span-full). */}
      <Card className="grid grid-cols-1 gap-x-10 gap-y-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        {spec.command && (
          <DefRow label={t('command')} wide>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12.5px] leading-relaxed text-foreground">
              <span className="select-none text-faint">$ </span>
              {highlightTemplate(spec.command)}
            </pre>
          </DefRow>
        )}
        <DefRow label={t('model')} mono>
          {spec.model ?? '—'}
        </DefRow>
        <DefRow label={t('image')} mono>
          {spec.image ? (
            <span className="inline-flex min-w-0 items-center gap-2">
              <span className="truncate">{spec.image}</span>
              <ImageClassBadge
                cls={spec.imageClasses?.find((x) => x.image === spec.image)?.class}
              />
            </span>
          ) : (
            t('defaultAgentImage')
          )}
        </DefRow>
        <DefRow label={t('workDir')} mono>
          {spec.workDir ?? 'work'}
        </DefRow>
        {trace && trace.kind !== 'none' && (
          <DefRow label={t('trace')} mono>
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
        <SubSection
          title={t('envVars')}
          icon={<Variable className="size-4" />}
          count={envKeys.length}
        >
          <Card className="divide-y divide-border">
            {envKeys.map((k) => (
              <div key={k} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <code className="font-mono text-[12px] text-foreground">{k}</code>
                <Mono>{envValueText(env[k], t('secretLabel'))}</Mono>
              </div>
            ))}
          </Card>
        </SubSection>
      )}
    </div>
  )
}
