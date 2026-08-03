'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/input'

import { completeCycleAction } from '../api/cycles'

// 이터레이션 닫기. 게이트가 아니다 — 남은 일이 있는 게 정상이고, 물어보는 건 "그 일을 어디로 옮길까" 하나뿐.
// 옮길 곳을 고르지 않으면 남은 이슈는 닫힌 사이클에 그대로 남는다(다음 사이클을 나중에 계획하는 팀의 흐름).
export function CompleteCycleButton({
  id,
  openCycles,
  unfinished,
}: {
  id: string
  // 같은 팀의 열린 사이클만. 다른 팀으로는 이월할 수 없다(서버도 거절한다).
  openCycles: { id: string; label: string }[]
  unfinished: number
}) {
  const t = useTranslations('cyclesPage')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [pending, startTransition] = useTransition()

  function submit() {
    startTransition(async () => {
      const r = await completeCycleAction(id, target || undefined)
      if (!r.ok) {
        toast.error(r.error ?? t('completeError'))
        return
      }
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <CheckCircle2 className="size-3.5" />
        {t('complete')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-md">
        <div className="space-y-4 p-5">
          <h2 className="text-[15px] font-[560] text-foreground">{t('completeTitle')}</h2>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {unfinished > 0 ? t('completeBody', { count: unfinished }) : t('completeBodyClean')}
          </p>
          {unfinished > 0 && openCycles.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="carry-to">{t('carryTo')}</Label>
              <Combobox
                id="carry-to"
                value={target}
                onChange={setTarget}
                placeholder={t('carryToNone')}
                options={[
                  { value: '', label: t('carryToNone') },
                  ...openCycles.map((c) => ({ value: c.id, label: c.label })),
                ]}
              />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button size="sm" disabled={pending} onClick={submit}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('complete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
