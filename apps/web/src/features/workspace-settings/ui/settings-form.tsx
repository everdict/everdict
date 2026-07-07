'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

import { updateWorkspaceSettingsAction, type WorkspaceSettings } from '../api/workspace-settings'

// 워크스페이스 정책 폼. 지금은 사용량 계측 토글. 비-admin 은 읽기 전용(컨트롤플레인이 최종 강제).
export function SettingsForm({
  initial,
  canWrite,
}: {
  initial: WorkspaceSettings
  canWrite: boolean
}) {
  const t = useTranslations('workspaceSettings')
  const [meterUsage, setMeterUsage] = useState(initial.meterUsage ?? false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()

  async function onSave() {
    setBusy(true)
    setSaved(false)
    setError(undefined)
    const r = await updateWorkspaceSettingsAction({ meterUsage })
    setBusy(false)
    if (r.ok) {
      setSaved(true)
      setMeterUsage(r.settings?.meterUsage ?? meterUsage)
    } else {
      setError(r.error)
    }
  }

  return (
    <div className="space-y-5">
      <label className="flex items-start gap-3 rounded-lg border bg-card p-4 shadow-raise">
        <input
          type="checkbox"
          checked={meterUsage}
          disabled={!canWrite || busy}
          onChange={(e) => {
            setMeterUsage(e.target.checked)
            setSaved(false)
          }}
          className="mt-0.5 h-4 w-4 accent-primary"
        />
        <span className="text-[13px]">
          <span className="font-[510] text-foreground">{t('meterUsage')}</span>
          <span className="mt-0.5 block leading-relaxed text-muted-foreground">
            {t('meterUsageHint')}
          </span>
        </span>
      </label>
      {canWrite ? (
        <div className="flex items-center gap-3">
          <Button onClick={onSave} disabled={busy}>
            {busy ? t('saving') : t('save')}
          </Button>
          {saved && <span className="text-[13px] text-[var(--color-success)]">{t('saved')}</span>}
          {error && (
            <Callout tone="danger" className="py-1.5">
              {error}
            </Callout>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t('adminRequired')}</p>
      )}
    </div>
  )
}
