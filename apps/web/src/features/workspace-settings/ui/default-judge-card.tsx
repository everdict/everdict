'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Label } from '@/shared/ui/input'

import { updateWorkspaceSettingsAction } from '../api/workspace-settings'
import { defaultJudgeModelValue, type WorkspaceJudge } from '../model/settings-schema'

// Workspace default judge model — scores inline judge graders when a run/scorecard picks no explicit judge.
// Picking a registered model saves a {ref} binding; the control plane resolves its provider/endpoint/key at judge-run
// time (same first-class Model binding a harness / registered judge uses). models = this workspace's registered LLM models.
export function DefaultJudgeCard({
  initialJudge,
  models,
  canWrite,
}: {
  initialJudge?: WorkspaceJudge
  models: { id: string; provider: string; model: string }[]
  canWrite: boolean
}) {
  const t = useTranslations('defaultJudge')
  const [modelId, setModelId] = useState(defaultJudgeModelValue(initialJudge))
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()

  async function onSave() {
    if (!modelId) return
    setBusy(true)
    setSaved(false)
    setError(undefined)
    // A picked registered model → a {ref} binding; the model's connection resolves at dispatch.
    const r = await updateWorkspaceSettingsAction({ judge: { model: { ref: modelId } } })
    setBusy(false)
    if (r.ok) setSaved(true)
    else setError(r.error)
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
      <div>
        <h3 className="text-[13px] font-[560] text-foreground">{t('title')}</h3>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{t('hint')}</p>
      </div>
      {models.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('noModels')}</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label>{t('modelLabel')}</Label>
            <Combobox
              value={modelId}
              onChange={(v) => {
                setModelId(v)
                setSaved(false)
              }}
              placeholder={t('placeholder')}
              options={models.map((m) => ({
                value: m.id,
                label: m.id,
                hint: `${m.provider} · ${m.model}`,
              }))}
              disabled={!canWrite || busy}
              aria-label={t('modelLabel')}
            />
          </div>
          {canWrite ? (
            <div className="flex items-center gap-3">
              <Button onClick={onSave} disabled={busy || !modelId}>
                {busy ? t('saving') : t('save')}
              </Button>
              {saved && (
                <span className="text-[13px] text-[var(--color-success)]">{t('saved')}</span>
              )}
              {error && (
                <Callout tone="danger" className="py-1.5">
                  {error}
                </Callout>
              )}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">{t('adminRequired')}</p>
          )}
        </>
      )}
    </div>
  )
}
