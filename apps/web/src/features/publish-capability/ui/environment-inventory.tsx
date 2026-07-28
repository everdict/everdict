'use client'

import { useState, useTransition } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { AdoptedEnvironment } from '@/entities/environment-adoption'
import { fmtDateTime } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'

import { unadoptEnvironmentAction, verifyAdoptedEnvironmentAction } from '../api/adopt-environment'

// Settings › Environments — the workspace's imported environment-image inventory: each row is a pinned store ref with
// its image and the latest pull-usability verification, plus re-check / remove for settings:write holders. Importing
// itself happens in the store catalog; this is the workspace-side ledger of what was brought in.
export function EnvironmentInventory({
  items,
  canManage,
}: {
  items: AdoptedEnvironment[]
  canManage: boolean
}) {
  const t = useTranslations('capabilityStore')
  const [rows, setRows] = useState(items)
  const [pending, startTransition] = useTransition()

  const sameRef = (a: AdoptedEnvironment, b: AdoptedEnvironment) =>
    a.source === b.source && a.id === b.id

  const reverify = (row: AdoptedEnvironment) =>
    startTransition(async () => {
      const r = await verifyAdoptedEnvironmentAction(row.source, row.id)
      if (r.ok) {
        setRows((prev) => prev.map((e) => (sameRef(e, row) ? r.environment : e)))
        toast.success(t('reverified'))
      } else toast.error(r.error ?? t('reverifyError'))
    })

  const remove = (row: AdoptedEnvironment) =>
    startTransition(async () => {
      const r = await unadoptEnvironmentAction(row.source, row.id)
      if (r.ok) {
        setRows((prev) => prev.filter((e) => !sameRef(e, row)))
        toast.success(t('unimported', { name: row.name ?? row.id }))
      } else toast.error(r.error ?? t('unimportError'))
    })

  // pull 불가 사유 배지 문구 — verify.reason 별(권한/없음/레지스트리 불통), 사유 없이 불가면 일반 "풀 불가".
  const reasonLabel = (reason: 'ok' | 'auth' | 'not-found' | 'unreachable' | undefined) => {
    if (reason === 'auth') return t('verifyAuth')
    if (reason === 'not-found') return t('verifyNotFound')
    if (reason === 'unreachable') return t('verifyUnreachable')
    return t('importedNotPullableBadge')
  }

  if (rows.length === 0)
    return <EmptyState title={t('adoptedEmptyTitle')} hint={t('adoptedEmptyHint')} />

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div
          key={`${row.source}/${row.id}`}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{row.name ?? row.id}</span>
              {!row.available && <Badge tone="danger">{t('envUnavailable')}</Badge>}
              {row.verify !== undefined &&
                (row.verify.pullable ? (
                  <Badge tone="success">{t('pullableBadge')}</Badge>
                ) : (
                  <Badge tone="warning">{reasonLabel(row.verify.reason)}</Badge>
                ))}
            </div>
            <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">
              {row.source}/{row.id}@{row.version}
              {row.image !== undefined ? ` · ${row.image}` : ''}
            </div>
          </div>
          <div className="shrink-0 text-[11.5px] text-faint">
            {fmtDateTime(row.verify?.at ?? row.adoptedAt)}
          </div>
          {canManage && (
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => reverify(row)}>
                <RefreshCw />
                {t('reverify')}
              </Button>
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => remove(row)}>
                <Trash2 />
                {t('inventoryRemove')}
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
