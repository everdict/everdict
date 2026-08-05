'use client'

import { useState } from 'react'
import { useRefresh } from '@/shared/lib/use-refresh'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { TeamWithSummary } from '@/entities/team'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { Switch } from '@/shared/ui/switch'

import { deleteTeamAction, setDefaultTeamAction, updateTeamAction } from '../api/manage-team'

// Settings › Teams › {team} › 일반 — 이 팀이 무엇인가(키·이름·설명·상위 팀)와, 누가 볼 수 있고 어디가 기본인가.
//
// 두 덩어리로 나뉜 이유는 저장 방식이 다르기 때문이다: 타이핑하는 값은 다 치고 나서 저장하고(그래서 아래에
// 저장 버튼이 붙는다), 스위치는 누르는 즉시 적용된다. 한 카드 안에 섞으면 스위치가 저장 버튼을 기다리는지
// 아닌지 알 수 없다.
export function TeamGeneralForm({
  team,
  parents,
  workspace,
  canWrite,
}: {
  team: TeamWithSummary
  // 상위로 걸 수 있는 팀들(자기 자신 제외). 자기 하위로 옮기는 시도는 제어 평면이 409로 거절한다.
  parents: { value: string; label: string }[]
  workspace: string
  canWrite: boolean
}) {
  const t = useTranslations('manageTeams')
  const router = useRouter()
  const refresh = useRefresh()
  const [error, setError] = useState<string>()
  const [name, setName] = useState(team.name)
  const [description, setDescription] = useState(team.description ?? '')
  const [parentId, setParentId] = useState(team.parentId ?? '')
  const [isPrivate, setIsPrivate] = useState(team.isPrivate)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, setPending] = useState(false)

  // 화면 갱신은 부르는 쪽의 몫이다 — 서버 액션은 제어 평면에 쓰고 돌아올 뿐이다(`.claude/rules/web.md`).
  function act(run: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(undefined)
    void (async () => {
      setPending(true)
      try {
        const r = await run()
        if (!r.ok) {
          setError(r.error)
          return
        }
        after?.()
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  // 즉시 적용되는 컨트롤(스위치)의 실패는 토스트로 알리고 서버 값으로 되돌린다.
  function applyNow(run: () => Promise<{ ok: boolean; error?: string }>, revert: () => void) {
    void (async () => {
      setPending(true)
      try {
        const r = await run()
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

  const dirty =
    name.trim() !== team.name ||
    description.trim() !== (team.description ?? '') ||
    parentId !== (team.parentId ?? '')

  return (
    <div className="space-y-6">
      {error !== undefined && <Callout tone="danger">{error}</Callout>}

      <div className="space-y-3">
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
              className="w-64"
            />
          </SettingsRow>
          <SettingsRow label={t('descriptionLabel')} htmlFor="team-description">
            <Input
              id="team-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canWrite}
              className="w-80"
            />
          </SettingsRow>
          <SettingsRow label={t('parentLabel')} htmlFor="team-parent" hint={t('parentHint')}>
            <Combobox
              id="team-parent"
              value={parentId}
              onChange={setParentId}
              disabled={!canWrite}
              placeholder={t('parentNone')}
              className="w-64"
              options={[{ value: '', label: t('parentNone') }, ...parents]}
            />
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
                })
              )
            }
          >
            {t('save')}
          </Button>
        )}
      </div>

      <SettingsList>
        <SettingsRow label={t('privateLabel')} hint={t('privateHint')}>
          {/* 가시성 필터일 뿐 권한 축이 아니다 — 관리자는 어차피 로스터에 자신을 한 번에 넣을 수 있어서 계속 본다. */}
          <Switch
            checked={isPrivate}
            disabled={!canWrite || pending}
            aria-label={t('privateLabel')}
            onCheckedChange={(next) => {
              setIsPrivate(next)
              applyNow(
                () => updateTeamAction(team.id, { isPrivate: next }),
                () => setIsPrivate(!next)
              )
            }}
          />
        </SettingsRow>
        <SettingsRow label={t('defaultLabel')} hint={t('defaultHint')}>
          {/* 기본팀은 켜고 끄는 것이 아니라 넘기는 것이다 — 워크스페이스에 기본팀이 없는 순간은 없다. */}
          {team.isDefault ? (
            <span className="text-[12px] text-muted-foreground">{t('isDefault')}</span>
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

      {canWrite && (
        <div className="space-y-2 border-t border-border pt-5">
          {/* 기본팀·마지막 팀·이슈를 든 팀은 서버가 거절한다 — 여기서 미리 감추지 않고 이유를 그대로 보여준다. */}
          <p className="text-[12px] text-muted-foreground">{t('deleteHint')}</p>
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
        </div>
      )}
    </div>
  )
}
