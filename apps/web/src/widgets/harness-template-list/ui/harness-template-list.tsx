'use client'

import Link from 'next/link'
import { Boxes, Layers, Plus, Shapes } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { HarnessTemplate } from '@/entities/harness'
import { StatCard } from '@/shared/ui/stat-card'

// 한 형상당 한 줄 — 무엇인지(kind·category·서비스 수) + 그 위에 올라탄 하네스들 + 하나 더 만들기.
// 아무도 올라타지 않은 형상은 별도로 표시한다: 그게 이 화면이 존재하는 이유(하네스 목록에는 나타나지 않는다).
export function HarnessTemplateList({
  workspace,
  templates,
  riders,
}: {
  workspace: string
  templates: HarnessTemplate[]
  riders: Record<string, string[]>
}) {
  const t = useTranslations('harnessTemplatesPage')
  const unused = templates.filter((x) => (riders[x.id] ?? []).length === 0).length

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label={t('statShapes')} value={templates.length} />
        <StatCard
          label={t('statHarnesses')}
          value={Object.values(riders).reduce((n, ids) => n + ids.length, 0)}
        />
        <StatCard
          label={t('statUnused')}
          value={unused}
          tone={unused > 0 ? 'primary' : 'default'}
        />
      </div>

      <div className="space-y-2">
        {[...templates]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((tpl) => {
            const ids = riders[tpl.id] ?? []
            const latest = tpl.latestVersion ?? tpl.versions[tpl.versions.length - 1]
            return (
              <div
                key={tpl.id}
                className="rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border">
                      <Shapes className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-[13px] font-[560] text-foreground">
                          {tpl.id}
                        </span>
                        {latest && (
                          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                            v{latest}
                          </code>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        {tpl.category && (
                          <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                            {tpl.category}
                          </span>
                        )}
                        {tpl.kind && (
                          <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground">
                            {tpl.kind}
                          </span>
                        )}
                        {tpl.serviceCount !== undefined && (
                          <span className="text-[10.5px] text-faint">
                            {t('serviceCount', { n: tpl.serviceCount })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <Link
                    href={`/${workspace}/harnesses/new?tab=instance&template=${encodeURIComponent(
                      tpl.id
                    )}${latest ? `&tplVersion=${encodeURIComponent(latest)}` : ''}`}
                    className="inline-flex shrink-0 items-center gap-1 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
                  >
                    <Plus className="size-3.5" />
                    {t('newHarness')}
                  </Link>
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-11 text-[11.5px] text-faint">
                  <span className="inline-flex items-center gap-1">
                    <Layers className="size-3.5" />
                    {t('versions')}{' '}
                    <span className="tabular-nums text-muted-foreground">
                      {tpl.versions.length}
                    </span>
                  </span>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <Boxes className="size-3.5" />
                    {ids.length === 0 ? (
                      // 아무도 올라타지 않은 형상 — 하네스 목록에는 아예 나오지 않으므로 여기서만 보인다.
                      <span className="text-muted-foreground">{t('noHarness')}</span>
                    ) : (
                      ids.slice(0, 4).map((id) => (
                        <Link
                          key={id}
                          href={`/${workspace}/harness/${encodeURIComponent(id)}`}
                          className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground transition-colors hover:text-foreground"
                        >
                          {id}
                        </Link>
                      ))
                    )}
                    {ids.length > 4 && <span className="text-faint">+{ids.length - 4}</span>}
                  </span>
                </div>
              </div>
            )
          })}
      </div>
    </div>
  )
}
