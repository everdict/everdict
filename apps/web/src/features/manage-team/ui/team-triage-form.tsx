'use client'

import { useState } from 'react'
import { useRefresh } from '@/shared/lib/use-refresh'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { Switch } from '@/shared/ui/switch'

import { updateTeamAction } from '../api/manage-team'

// 트리아지는 워크플로 **앞의** 큐다(docs/tracker.md) — 그래서 워크플로 탭의 첫 줄이다. 큐를 요청하지 않은
// 팀에게 빈 인박스를 보여주지 않도록, 켠 팀만 사이드바에 트리아지 줄을 갖는다.
export function TeamTriageForm({
  teamId,
  enabled,
  canWrite,
}: {
  teamId: string
  enabled: boolean
  canWrite: boolean
}) {
  const t = useTranslations('manageTeams')
  const refresh = useRefresh()
  const [on, setOn] = useState(enabled)
  const [pending, setPending] = useState(false)

  return (
    <SettingsList>
      <SettingsRow label={t('triageLabel')} hint={t('triageHint')}>
        <Switch
          checked={on}
          disabled={!canWrite || pending}
          aria-label={t('triageLabel')}
          onCheckedChange={(next) => {
            setOn(next)
            void (async () => {
              setPending(true)
              try {
                const r = await updateTeamAction(teamId, { triageEnabled: next })
                if (!r.ok) {
                  toast.error(r.error ?? t('saveError'))
                  setOn(!next)
                  return
                }
                refresh()
              } finally {
                setPending(false)
              }
            })()
          }}
        />
      </SettingsRow>
    </SettingsList>
  )
}
