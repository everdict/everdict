'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Megaphone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { HealthPicker, type TrackerHealth } from '@/entities/tracker-health'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/input'

import { postProjectUpdateAction } from '../api/projects'

// 업데이트 올리기. 판정(health)과 그 문장을 한 폼에 둔 이유는 둘이 한 진술이기 때문이다 — 본문 없는 판정은
// 서버도 거절한다. 판정 줄 자체는 이니셔티브 업데이트와 공유한다(entities/tracker-health).
export function ProjectUpdatePanel({ id }: { id: string }) {
  const t = useTranslations('projectsPage')
  const router = useRouter()
  const [health, setHealth] = useState<TrackerHealth>('on_track')
  const [body, setBody] = useState('')
  const [pending, startTransition] = useTransition()

  function submit() {
    const trimmed = body.trim()
    if (trimmed.length === 0) return
    startTransition(async () => {
      const r = await postProjectUpdateAction(id, { health, body: trimmed })
      if (!r.ok) {
        toast.error(r.error ?? t('updateError'))
        return
      }
      setBody('')
      router.refresh()
    })
  }

  return (
    <form
      className="space-y-2 rounded-lg border bg-card p-3 shadow-raise"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <HealthPicker value={health} onChange={setHealth} />
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('updatePlaceholder')}
        rows={3}
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending || body.trim().length === 0}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Megaphone className="size-3.5" />
          )}
          {t('postUpdate')}
        </Button>
      </div>
    </form>
  )
}
