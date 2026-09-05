import { ArrowRight, BarChart3, Boxes, Database, Gavel, Plug } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { cn } from '@/shared/lib/utils'
import { buttonVariants } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Link } from '@/shared/ui/link'

// The onboarding guide for a new user — it walks everdict's eval-first flow (harness → dataset → scorecard → judge)
// as numbered cards, each step deep-linking into that section. It ends with the "connect a coding agent" CTA (/connect).
// The icons are the sidebar nav's (Boxes/Database/BarChart3/Gavel) so the concepts are joined by eye.
const STEPS = [
  { key: 'harness', href: '/harnesses', icon: Boxes },
  { key: 'dataset', href: '/datasets', icon: Database },
  { key: 'scorecard', href: '/scorecards', icon: BarChart3 },
  { key: 'judge', href: '/judges', icon: Gavel },
] as const

export async function UsageGuide({ workspace }: { workspace: string }) {
  const t = await getTranslations('guidePage')
  return (
    <div className="space-y-6">
      <ol className="space-y-3">
        {STEPS.map((step, i) => {
          const Icon = step.icon
          return (
            <li key={step.key}>
              <Card className="flex items-start gap-3.5 p-4">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary/12 text-[12px] font-[560] text-primary ring-1 ring-inset ring-primary/20">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" strokeWidth={1.75} />
                    <h3 className="text-[13px] font-[560] text-foreground">
                      {t(`steps.${step.key}.title`)}
                    </h3>
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    {t(`steps.${step.key}.body`)}
                  </p>
                </div>
                <Link
                  href={`/${workspace}${step.href}`}
                  className={cn(
                    buttonVariants({ size: 'xs', variant: 'secondary' }),
                    'mt-0.5 shrink-0'
                  )}
                >
                  {t('open')}
                  <ArrowRight />
                </Link>
              </Card>
            </li>
          )
        })}
      </ol>

      {/* The connect-a-coding-agent CTA — the guide's destination (driving evaluations from the editor) */}
      <Card className="flex flex-wrap items-center justify-between gap-3 border-primary/25 bg-primary/[0.04] p-4">
        <div className="flex items-start gap-3.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary/12 text-primary ring-1 ring-inset ring-primary/20">
            <Plug className="size-4" strokeWidth={1.75} />
          </span>
          <div className="space-y-1">
            <h3 className="text-[13px] font-[560] text-foreground">{t('connect.title')}</h3>
            <p className="text-[13px] leading-relaxed text-muted-foreground">{t('connect.body')}</p>
          </div>
        </div>
        <Link
          href={`/${workspace}/connect/desktop`}
          className={cn(buttonVariants({ size: 'sm' }), 'shrink-0')}
        >
          {t('connect.cta')}
          <ArrowRight />
        </Link>
      </Card>
    </div>
  )
}
