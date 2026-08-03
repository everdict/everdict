'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Megaphone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { PROJECT_HEALTH, type ProjectHealth } from '@/entities/project'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/input'
import { cn } from '@/shared/lib/utils'

import { postProjectUpdateAction } from '../api/projects'

// 업데이트 올리기. 판정(health)과 그 문장을 한 폼에 둔 이유는 둘이 한 진술이기 때문이다 — 본문 없는 판정은
// 서버도 거절한다. 색은 이탈/위험에만 준다: 세 단계를 다 물들이면 "정상"이 초록 소음이 된다.
const TONE: Record<ProjectHealth, string> = {
  on_track: 'border-border text-muted-foreground',
  at_risk: 'border-[var(--color-warning)]/40 text-[var(--color-warning)]',
  off_track: 'border-destructive/40 text-destructive',
}

export function ProjectUpdatePanel({ id }: { id: string }) {
  const t = useTranslations('projectsPage')
  const tracker = useTranslations('tracker')
  const router = useRouter()
  const [health, setHealth] = useState<ProjectHealth>('on_track')
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
      <div className="flex flex-wrap items-center gap-1.5">
        {PROJECT_HEALTH.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setHealth(option)}
            aria-pressed={health === option}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors',
              health === option ? TONE[option] : 'border-border text-muted-foreground hover:text-foreground',
              health === option && 'bg-accent'
            )}
          >
            {tracker(`projectHealth.${option}`)}
          </button>
        ))}
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('updatePlaceholder')}
        rows={3}
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending || body.trim().length === 0}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Megaphone className="size-3.5" />}
          {t('postUpdate')}
        </Button>
      </div>
    </form>
  )
}
