'use client'

import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { createCycleAction } from '../api/cycles'

// 다음 이터레이션 계획하기. 날짜를 비우면 팀 주기에서 제안된 창이 쓰인다 — 그래서 기본 흐름은 "이름 없이
// 바로 만들기" 한 번이고, 날짜는 건너뛴 주가 있을 때만 손댄다.
export function CreateCycleButton({ teamId }: { teamId: string }) {
  const t = useTranslations('cyclesPage')
  const refresh = useRefresh()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [pending, setPending] = useState(false)

  // 반쪽 창은 서버가 400 으로 거절한다 — 누르기 전에 알려주는 편이 낫다.
  const halfWindow = (startsAt === '') !== (endsAt === '')

  function submit() {
    void (async () => {
      setPending(true)
      try {
        const r = await createCycleAction({
          teamId,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(startsAt && endsAt ? { startsAt, endsAt } : {}),
        })
        if (!r.ok || !r.cycle) {
          toast.error(r.error ?? t('createError'))
          return
        }
        setOpen(false)
        setName('')
        setDescription('')
        setStartsAt('')
        setEndsAt('')
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t('create')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-lg">
        <form
          className="@container space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <h2 className="text-[15px] font-[560] text-foreground">{t('createTitle')}</h2>
          <p className="text-[12px] leading-relaxed text-muted-foreground">{t('createHint')}</p>
          <div className="space-y-1.5">
            <Label htmlFor="cycle-name">{t('fieldName')}</Label>
            <Input
              id="cycle-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder={t('fieldNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cycle-description">{t('fieldDescription')}</Label>
            <Textarea
              id="cycle-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-3 @md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cycle-starts">{t('fieldStartsAt')}</Label>
              <Input
                id="cycle-starts"
                type="date"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cycle-ends">{t('fieldEndsAt')}</Label>
              <Input
                id="cycle-ends"
                type="date"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </div>
          </div>
          {halfWindow && <p className="text-[12px] text-destructive">{t('halfWindow')}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={pending || halfWindow}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('createSubmit')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
