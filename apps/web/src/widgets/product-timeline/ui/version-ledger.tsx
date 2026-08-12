'use client'

import { useMemo, useState } from 'react'
import { ExternalLink, GitBranch, Tag } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { ProductService, ProductVersion } from '@/entities/product'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'

// 임포트된 버전 원장 — 서비스별로. 한 프로덕트가 여러 서비스를 조립하면 버전은 각자의 스트림에서
// 따로 움직이고, 한 표에 시간순으로 섞어 놓으면 "api 가 지금 어디까지 왔나"라는 실제 질문에 답할 수
// 없다(스크롤하며 이름을 눈으로 걸러야 한다). 그래서 축은 서비스이고, 시간은 그 안에서만 흐른다.
const COLLAPSED_ROWS = 6

interface LedgerGroup {
  service: string
  tracked?: ProductService
  versions: ProductVersion[]
}

export function ProductVersionLedger({
  services,
  versions,
}: {
  services: ProductService[]
  versions: ProductVersion[]
}) {
  const locale = useLocale()

  const groups = useMemo<LedgerGroup[]>(() => {
    const byService = new Map<string, ProductVersion[]>()
    for (const version of versions) {
      const rows = byService.get(version.service)
      if (rows) rows.push(version)
      else byService.set(version.service, [version])
    }
    // 선언된 서비스가 먼저, 선언 순서 그대로 — 원장은 프로덕트의 구성을 비추는 것이지 자기 순서를
    // 주장하지 않는다. 선언에 없는데 원장에 남아 있는 이름은 뒤에 따로 세운다: 이름이 바뀌었거나
    // 저장소를 옮긴 서비스의 과거이고, 조용히 감추면 "임포트가 사라졌다"로 읽힌다.
    const declared: LedgerGroup[] = services.map((service) => ({
      service: service.name,
      tracked: service,
      versions: byService.get(service.name) ?? [],
    }))
    const declaredNames = new Set(services.map((service) => service.name))
    const orphans: LedgerGroup[] = [...byService.entries()]
      .filter(([name]) => !declaredNames.has(name))
      .map(([name, rows]) => ({ service: name, versions: rows }))
    return [...declared, ...orphans]
  }, [services, versions])

  const dateLabel = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
    return (iso: string) => format.format(new Date(iso))
  }, [locale])

  if (groups.length === 0) return null

  return (
    <div className="grid gap-2.5 @2xl:grid-cols-2 @5xl:grid-cols-3">
      {groups.map((group) => (
        <ServiceLedgerCard key={group.service} group={group} dateLabel={dateLabel} />
      ))}
    </div>
  )
}

function ServiceLedgerCard({
  group,
  dateLabel,
}: {
  group: LedgerGroup
  dateLabel: (iso: string) => string
}) {
  const t = useTranslations('productPage')
  const [expanded, setExpanded] = useState(false)
  // 원장은 최신 발행부터. publishedAt 은 원격(GitHub)의 시계다 — 우리가 언제 가져왔는지가 아니라
  // 세상에서 언제 나갔는지가 순서를 정한다.
  const ordered = [...group.versions].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  const shown = expanded ? ordered : ordered.slice(0, COLLAPSED_ROWS)
  const hidden = ordered.length - shown.length

  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-[510]">{group.service}</span>
        {group.tracked === undefined ? (
          <Badge tone="warning" title={t('untrackedHint')}>
            {t('untracked')}
          </Badge>
        ) : (
          group.tracked.tagPrefix && <Badge tone="neutral">{group.tracked.tagPrefix}*</Badge>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
          {t('versionCount', { count: ordered.length })}
        </span>
      </div>
      {group.tracked && (
        <p className="-mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {group.tracked.repository}
          {group.tracked.path !== undefined && (
            <span className="text-muted-foreground/70">/{group.tracked.path}</span>
          )}
        </p>
      )}

      {ordered.length === 0 ? (
        <p className="py-1 text-[12px] text-muted-foreground">{t('noVersionsYet')}</p>
      ) : (
        <ul className="space-y-0.5">
          {shown.map((version, index) => (
            <li
              key={version.id}
              className={cn(
                'flex items-baseline gap-2 rounded px-1 py-1 text-[12.5px]',
                // 가장 최신 한 줄만 강조한다 — "지금 이 서비스는 어디까지 왔나"가 이 카드의 첫 질문이다.
                index === 0 && !expanded ? 'bg-elevated' : null
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                {version.url ? (
                  <a
                    href={version.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-baseline gap-1 hover:text-primary hover:underline"
                  >
                    {version.version}
                    <ExternalLink className="size-3 self-center opacity-60" aria-hidden />
                  </a>
                ) : (
                  version.version
                )}
              </span>
              {version.prerelease && <Badge tone="warning">{t('prerelease')}</Badge>}
              {/* 릴리즈가 아니라 태그에서 온 행이라는 사실은 남긴다 — 같은 원장 안에서 근거의 무게가 다르다. */}
              {version.kind === 'tag' && (
                <Tag className="size-3 shrink-0 self-center text-muted-foreground" aria-hidden />
              )}
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {dateLabel(version.publishedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('showAllVersions', { count: hidden })}
        </button>
      )}
    </Card>
  )
}
