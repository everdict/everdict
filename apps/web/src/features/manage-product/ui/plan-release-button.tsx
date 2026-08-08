'use client'

import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'
import { MultiSelect } from '@/shared/ui/multi-select'

import { createReleaseAction } from '../api/products'

// 릴리즈 계획 — 이름 · 목표일 · 이 릴리즈가 판정받을 워치 시리즈(비우면 전부). 출하는 릴리즈 상세의
// 게이트를 통해서만 간다.
export function PlanReleaseButton({
  productId,
  seriesOptions,
}: {
  productId: string
  // 프로덕트가 선언한 시리즈들 — 선택지는 컨트롤 플레인이 받아 주는 것만(없는 키는 400 이다).
  seriesOptions: { key: string; label: string }[]
}) {
  const t = useTranslations('productsPage')
  const refresh = useRefresh()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [seriesKeys, setSeriesKeys] = useState<string[]>([])
  const [pending, setPending] = useState(false)

  function submit() {
    if (name.trim().length === 0) return
    void (async () => {
      setPending(true)
      try {
        const r = await createReleaseAction(productId, {
          name: name.trim(),
          ...(targetDate ? { targetDate } : {}),
          ...(seriesKeys.length > 0 ? { seriesKeys } : {}),
        })
        if (!r.ok) {
          toast.error(r.error ?? t('planReleaseError'))
          return
        }
        setOpen(false)
        setName('')
        setTargetDate('')
        setSeriesKeys([])
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t('planRelease')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-md">
        <div className="space-y-4 p-5">
          <h2 className="text-sm font-semibold">{t('planReleaseTitle')}</h2>
          <div className="space-y-1.5">
            <Label htmlFor="release-name">{t('releaseName')}</Label>
            <Input
              id="release-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('releaseNamePlaceholder')}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="release-target">{t('releaseTargetDate')}</Label>
            <Input
              id="release-target"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </div>
          {seriesOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label>{t('releaseSeries')}</Label>
              <MultiSelect
                options={seriesOptions.map((s) => ({ value: s.key, label: s.label }))}
                selected={seriesKeys}
                onChange={setSeriesKeys}
                placeholder={t('releaseSeriesAll')}
                emptyLabel={t('releaseSeriesAll')}
                removeLabel={(name) => t('removeSeries', { name })}
              />
              <p className="text-xs text-muted-foreground">{t('releaseSeriesHint')}</p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button size="sm" onClick={submit} disabled={pending || name.trim().length === 0}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t('planReleaseSubmit')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
