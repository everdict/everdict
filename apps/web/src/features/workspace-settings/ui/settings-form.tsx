'use client'

import { useState } from 'react'

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
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={meterUsage}
          disabled={!canWrite || busy}
          onChange={(e) => {
            setMeterUsage(e.target.checked)
            setSaved(false)
          }}
          className="mt-1 h-4 w-4 accent-primary"
        />
        <span className="text-sm">
          <span className="font-medium">사용량 계측 (usage metering)</span>
          <span className="block text-muted-foreground">
            이 워크스페이스의 run 에서 모델 호출 토큰/비용을 회수해 버짓에 반영합니다. 요청별
            override(POST /runs meterUsage)가 이 기본값보다 우선합니다.
          </span>
        </span>
      </label>
      {canWrite ? (
        <div className="flex items-center gap-3">
          <Button onClick={onSave} disabled={busy}>
            {busy ? '저장 중…' : '저장'}
          </Button>
          {saved && <span className="text-sm text-[var(--color-success)]">저장됨</span>}
          {error && (
            <Callout tone="danger" className="py-1.5">
              {error}
            </Callout>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          변경하려면 admin 역할(settings:write)이 필요합니다.
        </p>
      )}
    </div>
  )
}
