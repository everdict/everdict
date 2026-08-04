'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { memberNameOf, type MemberDirectory } from '@/entities/member'
import type { TeamMember, TeamWithSummary } from '@/entities/team'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  addTeamMemberAction,
  deleteTeamAction,
  removeTeamMemberAction,
  setDefaultTeamAction,
  updateTeamAction,
} from '../api/manage-team'

// 사이클이 시작하는 요일. 0 = 일요일 … 6 = 토요일 — 제어 평면과 `Date#getUTCDay` 가 쓰는 것과 같은 번호다.
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

// Settings › Teams › {team} — 한 팀의 일반 설정 + 로스터. Linear 의 팀 설정과 같은 두 덩어리다.
export function TeamDetailManager({
  team,
  members,
  parents,
  candidates,
  directory,
  workspace,
  canWrite,
}: {
  team: TeamWithSummary
  members: TeamMember[]
  // 상위로 걸 수 있는 팀들(자기 자신 제외). 자기 하위로 옮기는 시도는 제어 평면이 409로 거절한다.
  parents: { value: string; label: string }[]
  candidates: { value: string; label: string }[]
  // subject → 사람. 이 페이지는 서버에서 이미 워크스페이스 멤버를 읽으므로 클라이언트 조회를 또 하지 않는다
  // (entities/member 의 지연 디렉토리는 그 데이터가 없는 화면용이다).
  directory: MemberDirectory
  workspace: string
  canWrite: boolean
}) {
  const t = useTranslations('manageTeams')
  const router = useRouter()
  const [error, setError] = useState<string>()
  const [name, setName] = useState(team.name)
  const [description, setDescription] = useState(team.description ?? '')
  const [parentId, setParentId] = useState(team.parentId ?? '')
  const [cyclesOn, setCyclesOn] = useState(team.cyclesEnabled)
  const [cycleWeeks, setCycleWeeks] = useState(String(team.cycleDurationWeeks))
  const [cycleStartDay, setCycleStartDay] = useState(String(team.cycleStartDay))
  const [upcomingCycles, setUpcomingCycles] = useState(String(team.upcomingCycleCount))
  const [autoClose, setAutoClose] = useState(team.cycleAutoClose)
  const [triage, setTriage] = useState(team.triageEnabled)
  const [isPrivate, setIsPrivate] = useState(team.isPrivate)
  const [addSubject, setAddSubject] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, startTransition] = useTransition()

  function act(run: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(undefined)
    startTransition(async () => {
      const r = await run()
      if (!r.ok) {
        setError(r.error)
        return
      }
      after?.()
    })
  }

  const dirty =
    name.trim() !== team.name ||
    description.trim() !== (team.description ?? '') ||
    parentId !== (team.parentId ?? '') ||
    cyclesOn !== team.cyclesEnabled ||
    cycleWeeks !== String(team.cycleDurationWeeks) ||
    cycleStartDay !== String(team.cycleStartDay) ||
    upcomingCycles !== String(team.upcomingCycleCount) ||
    autoClose !== team.cycleAutoClose ||
    triage !== team.triageEnabled ||
    isPrivate !== team.isPrivate
  const onRoster = new Set(members.map((m) => m.subject))
  const addable = candidates.filter((c) => !onRoster.has(c.value))

  return (
    <div className="space-y-8">
      {error !== undefined && <Callout tone="danger">{error}</Callout>}

      <section className="space-y-3">
        <SettingsList>
          {/* 키는 읽기 전용 — 이 팀이 이미 발행한 모든 식별자에 박혀 있다. */}
          <SettingsRow label={t('keyLabel')} hint={t('keyImmutable')}>
            <span className="font-mono text-[13px] text-muted-foreground">{team.key}</span>
          </SettingsRow>
          <SettingsRow label={t('nameLabel')} htmlFor="team-name">
            <Input
              id="team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canWrite}
              className="w-56"
            />
          </SettingsRow>
          <SettingsRow label={t('descriptionLabel')} htmlFor="team-description">
            <Input
              id="team-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canWrite}
              className="w-72"
            />
          </SettingsRow>
          <SettingsRow label={t('parentLabel')} htmlFor="team-parent" hint={t('parentHint')}>
            <Combobox
              id="team-parent"
              value={parentId}
              onChange={setParentId}
              disabled={!canWrite}
              placeholder={t('parentNone')}
              className="w-72"
              options={[{ value: '', label: t('parentNone') }, ...parents]}
            />
          </SettingsRow>
          {/* 사이클 — 켜는 순간부터 사이클 목록을 읽을 때마다 "지금 있는 하나 + 예정 N개"가 세워진다.
              아래 세 줄은 그때 세워질 창의 모양이라, 켜지 않은 팀에게는 답할 것이 없는 질문이다. */}
          <SettingsRow label={t('cyclesLabel')} hint={t('cyclesHint')}>
            <Button
              size="sm"
              variant={cyclesOn ? 'primary' : 'secondary'}
              disabled={!canWrite}
              onClick={() => setCyclesOn((on) => !on)}
            >
              {cyclesOn ? t('cyclesOn') : t('cyclesOff')}
            </Button>
          </SettingsRow>
          {cyclesOn && (
            <>
              <SettingsRow label={t('cycleWeeksLabel')} htmlFor="team-cycle-weeks" hint={t('cycleWeeksHint')}>
                <Input
                  id="team-cycle-weeks"
                  type="number"
                  min={1}
                  max={12}
                  value={cycleWeeks}
                  onChange={(e) => setCycleWeeks(e.target.value)}
                  disabled={!canWrite}
                  className="w-24"
                />
              </SettingsRow>
              <SettingsRow
                label={t('cycleStartDayLabel')}
                htmlFor="team-cycle-start-day"
                hint={t('cycleStartDayHint')}
              >
                <Combobox
                  id="team-cycle-start-day"
                  value={cycleStartDay}
                  onChange={setCycleStartDay}
                  disabled={!canWrite}
                  className="w-40"
                  options={WEEKDAYS.map((day) => ({ value: String(day), label: t(`weekday.${day}`) }))}
                />
              </SettingsRow>
              <SettingsRow
                label={t('upcomingCyclesLabel')}
                htmlFor="team-upcoming-cycles"
                hint={t('upcomingCyclesHint')}
              >
                <Input
                  id="team-upcoming-cycles"
                  type="number"
                  min={0}
                  max={6}
                  value={upcomingCycles}
                  onChange={(e) => setUpcomingCycles(e.target.value)}
                  disabled={!canWrite}
                  className="w-24"
                />
              </SettingsRow>
              <SettingsRow label={t('autoCloseLabel')} hint={t('autoCloseHint')}>
                {/* 기본이 꺼짐인 것이 요점이다 — 아무도 안 닫은 사이클이 계속 보이는 것은 결함이 아니라
                    신호다. 리듬이 잡힌 팀만 리니어식으로 "그냥 끝나게" 바꾼다. */}
                <Button
                  size="sm"
                  variant={autoClose ? 'primary' : 'secondary'}
                  disabled={!canWrite}
                  onClick={() => setAutoClose((on) => !on)}
                >
                  {autoClose ? t('autoCloseOn') : t('autoCloseOff')}
                </Button>
              </SettingsRow>
            </>
          )}
          <SettingsRow label={t('triageLabel')} hint={t('triageHint')}>
            {/* 큐를 요청하지 않은 팀에게 빈 인박스를 보여주지 않도록, 켠 팀만 사이드바에 트리아지 줄을 갖는다. */}
            <Button
              size="sm"
              variant={triage ? 'primary' : 'secondary'}
              disabled={!canWrite}
              onClick={() => setTriage((on) => !on)}
            >
              {triage ? t('triageOn') : t('triageOff')}
            </Button>
          </SettingsRow>
          <SettingsRow label={t('privateLabel')} hint={t('privateHint')}>
            {/* 가시성 필터일 뿐 권한 축이 아니다 — 관리자는 어차피 로스터에 자신을 한 번에 넣을 수 있어서 계속 본다. */}
            <Button
              size="sm"
              variant={isPrivate ? 'primary' : 'secondary'}
              disabled={!canWrite}
              onClick={() => setIsPrivate((on) => !on)}
            >
              {isPrivate ? t('privateOn') : t('privateOff')}
            </Button>
          </SettingsRow>
          <SettingsRow label={t('defaultLabel')} hint={t('defaultHint')}>
            {team.isDefault ? (
              <span className="text-xs text-muted-foreground">{t('isDefault')}</span>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={!canWrite || pending}
                onClick={() => act(() => setDefaultTeamAction(team.id))}
              >
                {t('makeDefault')}
              </Button>
            )}
          </SettingsRow>
        </SettingsList>
        {canWrite && dirty && (
          <Button
            size="sm"
            disabled={pending || name.trim() === ''}
            onClick={() =>
              act(() =>
                updateTeamAction(team.id, {
                  name: name.trim(),
                  description: description.trim() === '' ? null : description.trim(),
                  parentId: parentId === '' ? null : parentId,
                  cyclesEnabled: cyclesOn,
                  cycleDurationWeeks: Number(cycleWeeks),
                  cycleStartDay: Number(cycleStartDay),
                  upcomingCycleCount: Number(upcomingCycles),
                  cycleAutoClose: autoClose,
                  triageEnabled: triage,
                  isPrivate,
                })
              )
            }
          >
            {t('save')}
          </Button>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-1.5 text-[13px] font-[510] text-foreground">
          {t('rosterTitle')}
          {/* 팀 소속은 권한이 아니다 — 도메인이 "가시성·소유의 진술이지 두 번째 인가 축이 아니다" 라고 못박고 있고,
              멤버 목록 바로 옆에 있는 이 화면에서 그 구분을 말해주지 않으면 여기서 권한을 준다고 읽힌다. */}
          <InfoTip content={t('rosterPermissionTip')} />
        </h2>
        <p className="text-xs text-muted-foreground">{t('rosterHint')}</p>
        <SettingsList>
          {members.map((m) => (
            // 로스터 행은 사람이다 — subject 는 불투명한 Keycloak sub 라서 그대로 두면 "누가 이 팀인지" 를
            // id 로 읽게 된다(리비전 히스토리에서 같은 이유로 고쳤던 것과 같은 결함).
            <SettingsRow key={m.subject} label={memberNameOf(directory, m.subject)}>
              {canWrite ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => act(() => removeTeamMemberAction(team.id, m.subject))}
                >
                  {t('remove')}
                </Button>
              ) : null}
            </SettingsRow>
          ))}
        </SettingsList>
        {canWrite && addable.length > 0 && (
          <div className="flex flex-col gap-2 @sm:flex-row">
            <Combobox
              value={addSubject}
              onChange={setAddSubject}
              options={addable}
              placeholder={t('addMemberPlaceholder')}
              className="min-w-0 flex-1"
            />
            <Button
              size="sm"
              disabled={addSubject === '' || pending}
              onClick={() =>
                act(
                  () => addTeamMemberAction(team.id, addSubject),
                  () => setAddSubject('')
                )
              }
            >
              {t('add')}
            </Button>
          </div>
        )}
      </section>

      {canWrite && (
        <section className="space-y-2">
          <h2 className="text-[13px] font-[510] text-foreground">{t('dangerTitle')}</h2>
          {/* 기본팀·마지막 팀·이슈를 든 팀은 서버가 거절한다 — 여기서 미리 감추지 않고 이유를 그대로 보여준다. */}
          <p className="text-xs text-muted-foreground">{t('deleteHint')}</p>
          {confirmDelete ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  act(
                    () => deleteTeamAction(team.id),
                    () => router.push(`/${workspace}/settings/teams`)
                  )
                }
              >
                {t('confirmDelete')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirmDelete(false)}
              >
                {t('cancel')}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(true)}>
              {t('delete')}
            </Button>
          )}
        </section>
      )}
    </div>
  )
}
