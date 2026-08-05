'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import {
  TEAM_KEY_PATTERN,
  TeamKeyBadge,
  teamSettingsHref,
  type TeamWithSummary,
} from '@/entities/team'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'
import { SettingsList } from '@/shared/ui/settings-list'

import { createTeamAction } from '../api/manage-team'

// Settings › Teams — 워크스페이스의 팀 목록. 행의 이름이 상세로 들어가는 드릴인이고(설정 목록 관례),
// 오른쪽은 그 팀의 상태(기본팀 여부·이슈 수)를 읽는 자리다.
export function TeamsManager({
  teams,
  workspace,
  canWrite,
}: {
  teams: TeamWithSummary[]
  workspace: string
  canWrite: boolean
}) {
  const t = useTranslations('manageTeams')
  const [error, setError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState('')
  const [pending, setPending] = useState(false)

  const normalizedKey = key.trim().toUpperCase()
  const keyValid = TEAM_KEY_PATTERN.test(normalizedKey)

  function onCreate() {
    setError(undefined)
    void (async () => {
      setPending(true)
      try {
        const r = await createTeamAction({
          key: normalizedKey,
          name: name.trim(),
          ...(parentId ? { parentId } : {}),
        })
        if (!r.ok) {
          setError(r.error)
          return
        }
        setCreating(false)
        setKey('')
        setName('')
        setParentId('')
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <div className="space-y-4">
      {error !== undefined && <Callout tone="danger">{error}</Callout>}

      <SettingsList>
        {teams.map((team) => (
          <li
            key={team.id}
            className="flex min-h-[60px] flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <Link
              href={teamSettingsHref(workspace, team.key)}
              className="flex min-w-0 items-center gap-2 hover:underline"
            >
              <TeamKeyBadge teamKey={team.key} />
              <span className="truncate text-[13px] font-[510] text-foreground">{team.name}</span>
              {team.isDefault && (
                <span className="shrink-0 rounded-sm bg-[var(--color-success)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-success)]">
                  {t('default')}
                </span>
              )}
            </Link>
            <span className="shrink-0 text-xs text-muted-foreground">
              {team.parentId !== undefined && (
                <span className="mr-2">
                  {t('rowParent', {
                    name: teams.find((x) => x.id === team.parentId)?.name ?? team.parentId,
                  })}
                </span>
              )}
              {t('rowSummary', {
                members: team.summary.memberCount,
                open: team.summary.openIssues,
              })}
            </span>
          </li>
        ))}
      </SettingsList>

      {canWrite &&
        (creating ? (
          <div className="@container space-y-3 rounded-lg border bg-card p-4 shadow-raise">
            <div className="grid gap-3 @sm:grid-cols-[8rem_1fr]">
              <div className="space-y-1">
                <label htmlFor="team-key" className="block text-[13px] font-[510]">
                  {t('keyLabel')}
                </label>
                <Input
                  id="team-key"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="ENG"
                  className="font-mono uppercase"
                />
                <p className="text-xs text-muted-foreground">{t('keyHint')}</p>
              </div>
              <div className="space-y-1">
                <label htmlFor="team-name" className="block text-[13px] font-[510]">
                  {t('nameLabel')}
                </label>
                <Input
                  id="team-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('namePlaceholder')}
                />
                {/* 키는 발행된 식별자에 박히므로 생성 후 바꿀 수 없다 — 만들기 전에 알려준다. */}
                <p className="text-xs text-muted-foreground">
                  {keyValid ? t('previewHint', { example: `${normalizedKey}-1` }) : t('keyInvalid')}
                </p>
              </div>
            </div>
            <div className="space-y-1">
              <label htmlFor="team-parent" className="block text-[13px] font-[510]">
                {t('parentLabel')}
              </label>
              {/* 상위 팀은 조직 표현일 뿐이다 — 하위 팀도 자기 이슈를 소유하고 자기 번호를 발번한다. */}
              <Combobox
                id="team-parent"
                value={parentId}
                onChange={setParentId}
                placeholder={t('parentNone')}
                options={[
                  { value: '', label: t('parentNone') },
                  ...teams.map((team) => ({ value: team.id, label: `${team.key} · ${team.name}` })),
                ]}
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!keyValid || name.trim() === '' || pending}
                onClick={onCreate}
              >
                {t('create')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setCreating(false)}
              >
                {t('cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            {t('newTeam')}
          </Button>
        ))}
    </div>
  )
}
