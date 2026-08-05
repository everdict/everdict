'use client'

import { useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { issueStatusIcon, type IssueStatus } from '@/entities/issue'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

import { acceptTriageAction, declineTriageAction } from '../api/issues'

// 트리아지에서 나가는 두 길. 워크플로 상태 컨트롤과 나란히 두지 않고 본문 맨 위 배너로 세운 이유는, 이 이슈에
// 대해 지금 할 일이 "받을까 말까" 하나뿐이기 때문이다 — 받아들이기 전까지 나머지 속성은 결정할 게 없다.
const ACCEPTABLE: IssueStatus[] = ['todo', 'backlog', 'in_progress', 'in_review']

export function IssueTriageActions({ id }: { id: string }) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')
  const refresh = useRefresh()
  const [declining, setDeclining] = useState(false)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)

  function accept(status: IssueStatus) {
    void (async () => {
      setPending(true)
      try {
        const r = await acceptTriageAction(id, status)
        if (!r.ok) {
          toast.error(r.error ?? t('triageAcceptError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  function decline() {
    void (async () => {
      setPending(true)
      try {
        const r = await declineTriageAction(id, note.trim() || undefined)
        if (!r.ok) {
          toast.error(r.error ?? t('triageDeclineError'))
          return
        }
        setDeclining(false)
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <Callout tone="info">
      <div className="@container space-y-2">
        <p className="text-[12.5px] leading-relaxed">{t('triageBanner')}</p>
        {declining ? (
          <div className="flex flex-col gap-2 @sm:flex-row">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('triageDeclineNote')}
              className="min-w-0 flex-1"
            />
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDeclining(false)}
                disabled={pending}
              >
                {t('cancel')}
              </Button>
              <Button size="sm" onClick={decline} disabled={pending}>
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('triageDecline')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu
              align="start"
              trigger={({ toggle, open }) => (
                <Button size="sm" onClick={toggle} aria-expanded={open} disabled={pending}>
                  {pending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  {t('triageAccept')}
                </Button>
              )}
            >
              <DropdownLabel>{t('triageAcceptInto')}</DropdownLabel>
              {ACCEPTABLE.map((status) => {
                const Icon = issueStatusIcon(status)
                return (
                  <DropdownItem
                    key={status}
                    icon={<Icon className="size-3.5" />}
                    onSelect={() => accept(status)}
                  >
                    {tracker(`issueStatus.${status}`)}
                  </DropdownItem>
                )
              })}
            </DropdownMenu>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setDeclining(true)}
              disabled={pending}
            >
              <X className="size-3.5" />
              {t('triageDecline')}
            </Button>
          </div>
        )}
      </div>
    </Callout>
  )
}
