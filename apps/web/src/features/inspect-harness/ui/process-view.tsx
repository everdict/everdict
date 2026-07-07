import { Cpu, ShieldCheck, Terminal } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { HarnessSpec } from '@/entities/harness'
import { Card } from '@/shared/ui/card'

import { Field } from './parts'

// process harness config — a single sandboxed process (Claude Code/Codex). No topology/pin targets.
export function ProcessView({ spec }: { spec: HarnessSpec }) {
  const t = useTranslations('inspectHarness')
  return (
    <div className="space-y-6">
      <Card className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-primary/10 blur-3xl" />
        <div className="flex items-start gap-4 p-5">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/12 text-[var(--color-accent-foreground)] ring-1 ring-inset ring-primary/20">
            <Cpu className="size-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 space-y-1">
            <h3 className="text-[14px] font-[560] text-foreground">{t('singleProcessTitle')}</h3>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t('singleProcessBody')}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-4 border-t border-border p-4">
          <Field label={t('kind')} value={spec.kind} />
          <Field label="id" value={spec.id} />
          <Field label={t('version')} value={spec.version} />
        </dl>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCard
          icon={<Terminal className="size-4" />}
          title={t('runModeTitle')}
          body={t('runModeBody')}
        />
        <InfoCard
          icon={<ShieldCheck className="size-4" />}
          title={t('isolationTitle')}
          body={t('isolationBody')}
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
