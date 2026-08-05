'use client'

import { useState } from 'react'
import { useRefresh } from '@/shared/lib/use-refresh'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { TeamWithSummary } from '@/entities/team'
import { Combobox } from '@/shared/ui/combobox'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { Switch } from '@/shared/ui/switch'

import { updateTeamAction } from '../api/manage-team'

// 사이클이 시작하는 요일. 0 = 일요일 … 6 = 토요일 — 제어 평면과 `Date#getUTCDay` 가 쓰는 것과 같은 번호다.
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const
// 제어 평면이 받는 범위 그대로 — 고르는 값이지 타이핑하는 값이 아니다(리니어도 드롭다운이다).
const WEEK_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const
const UPCOMING_OPTIONS = [0, 1, 2, 3, 4, 5, 6] as const

// Settings › Teams › {team} › 사이클 — 이 팀이 스스로를 재는 리듬.
//
// 전부 즉시 적용된다: 고르는 값(스위치·드롭다운)은 누른 것이 곧 결정이라, 저장 버튼을 기다리게 하면 이미
// 바뀐 것처럼 보이면서 안 바뀐 상태가 생긴다. 켜지 않은 팀에게 주기·시작 요일을 묻지 않는 것도 같은 이유다 —
// 답할 것이 없는 질문이다.
export function TeamCyclesForm({ team, canWrite }: { team: TeamWithSummary; canWrite: boolean }) {
  const t = useTranslations('manageTeams')
  const refresh = useRefresh()
  const [enabled, setEnabled] = useState(team.cyclesEnabled)
  const [weeks, setWeeks] = useState(String(team.cycleDurationWeeks))
  const [startDay, setStartDay] = useState(String(team.cycleStartDay))
  const [upcoming, setUpcoming] = useState(String(team.upcomingCycleCount))
  const [autoClose, setAutoClose] = useState(team.cycleAutoClose)
  const [pending, setPending] = useState(false)

  // 실패하면 토스트로 알리고 서버가 아는 값으로 되돌린다 — 화면에만 남는 설정이 제일 나쁘다.
  function applyNow(patch: Parameters<typeof updateTeamAction>[1], revert: () => void): void {
    void (async () => {
      setPending(true)
      try {
        const r = await updateTeamAction(team.id, patch)
        if (!r.ok) {
          toast.error(r.error ?? t('saveError'))
          revert()
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const locked = !canWrite || pending

  return (
    <SettingsList>
      <SettingsRow label={t('cyclesLabel')} hint={t('cyclesHint')}>
        <Switch
          checked={enabled}
          disabled={locked}
          aria-label={t('cyclesLabel')}
          onCheckedChange={(next) => {
            setEnabled(next)
            applyNow({ cyclesEnabled: next }, () => setEnabled(!next))
          }}
        />
      </SettingsRow>
      {enabled && (
        <>
          <SettingsRow label={t('cycleWeeksLabel')} htmlFor="team-cycle-weeks">
            <Combobox
              id="team-cycle-weeks"
              value={weeks}
              disabled={locked}
              className="w-40"
              options={WEEK_OPTIONS.map((count) => ({
                value: String(count),
                label: t('cycleWeeksOption', { count }),
              }))}
              onChange={(next) => {
                const previous = weeks
                setWeeks(next)
                applyNow({ cycleDurationWeeks: Number(next) }, () => setWeeks(previous))
              }}
            />
          </SettingsRow>
          <SettingsRow label={t('cycleStartDayLabel')} htmlFor="team-cycle-start-day">
            <Combobox
              id="team-cycle-start-day"
              value={startDay}
              disabled={locked}
              className="w-40"
              options={WEEKDAYS.map((day) => ({
                value: String(day),
                label: t(`weekday.${day}`),
              }))}
              onChange={(next) => {
                const previous = startDay
                setStartDay(next)
                applyNow({ cycleStartDay: Number(next) }, () => setStartDay(previous))
              }}
            />
          </SettingsRow>
          <SettingsRow
            label={t('upcomingCyclesLabel')}
            htmlFor="team-upcoming-cycles"
            hint={t('upcomingCyclesHint')}
          >
            <Combobox
              id="team-upcoming-cycles"
              value={upcoming}
              disabled={locked}
              className="w-40"
              options={UPCOMING_OPTIONS.map((count) => ({
                value: String(count),
                label: t('upcomingCyclesOption', { count }),
              }))}
              onChange={(next) => {
                const previous = upcoming
                setUpcoming(next)
                applyNow({ upcomingCycleCount: Number(next) }, () => setUpcoming(previous))
              }}
            />
          </SettingsRow>
          <SettingsRow label={t('autoCloseLabel')} hint={t('autoCloseHint')}>
            {/* 기본이 꺼짐인 것이 요점이다 — 아무도 안 닫은 사이클이 계속 보이는 것은 결함이 아니라
                신호다. 리듬이 잡힌 팀만 리니어식으로 "그냥 끝나게" 바꾼다. */}
            <Switch
              checked={autoClose}
              disabled={locked}
              aria-label={t('autoCloseLabel')}
              onCheckedChange={(next) => {
                setAutoClose(next)
                applyNow({ cycleAutoClose: next }, () => setAutoClose(!next))
              }}
            />
          </SettingsRow>
        </>
      )}
    </SettingsList>
  )
}
