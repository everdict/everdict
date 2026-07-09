'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import type { BudgetLimit, BudgetUsage } from '@/entities/budget'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { setBudgetLimitAction } from '../api/manage-budget'

// A blank field = unlimited on that dimension. Reject negatives / non-numbers (they simply don't submit).
const toNum = (s: string): number | undefined => {
  const trimmed = s.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
const fromNum = (n?: number): string => (n === undefined ? '' : String(n))

// Workspace enforcement budget — per-tenant caps on cost (usd), tokens, and run count. When a cap is hit the control
// plane blocks further runs with 402 (distinct from meter-only usage). Admin-only; a blank dimension is unlimited.
export function BudgetManager({
  usage,
  limit,
  canWrite,
}: {
  usage: BudgetUsage
  limit: BudgetLimit | null
  canWrite: boolean
}) {
  const t = useTranslations('manageBudget')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [usd, setUsd] = useState(fromNum(limit?.usd))
  const [tokens, setTokens] = useState(fromNum(limit?.tokens))
  const [runs, setRuns] = useState(fromNum(limit?.runs))

  const rowLabel = (text: string, tip: string) => (
    <span className="flex items-center gap-1.5">
      {text}
      <InfoTip content={tip} />
    </span>
  )

  function onSave() {
    setError(undefined)
    setSaved(false)
    startTransition(async () => {
      // A PUT replaces the whole limit — only send the dimensions the user left set.
      const r = await setBudgetLimitAction({
        ...(toNum(usd) !== undefined ? { usd: toNum(usd) } : {}),
        ...(toNum(tokens) !== undefined ? { tokens: toNum(tokens) } : {}),
        ...(toNum(runs) !== undefined ? { runs: toNum(runs) } : {}),
      })
      if (r.ok) setSaved(true)
      else setError(r.error)
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
          {t('title')}
          <InfoTip content={t('titleTip')} />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
      </div>

      <SettingsList>
        <SettingsRow label={rowLabel(t('usdLabel'), t('usdTip'))} htmlFor="budget-usd">
          <Input
            id="budget-usd"
            type="number"
            min={0}
            inputMode="decimal"
            className="w-40"
            placeholder={t('unlimitedPlaceholder')}
            value={usd}
            disabled={!canWrite || pending}
            onChange={(e) => setUsd(e.target.value)}
          />
        </SettingsRow>
        <SettingsRow label={rowLabel(t('tokensLabel'), t('tokensTip'))} htmlFor="budget-tokens">
          <Input
            id="budget-tokens"
            type="number"
            min={0}
            className="w-40"
            placeholder={t('unlimitedPlaceholder')}
            value={tokens}
            disabled={!canWrite || pending}
            onChange={(e) => setTokens(e.target.value)}
          />
        </SettingsRow>
        <SettingsRow label={rowLabel(t('runsLabel'), t('runsTip'))} htmlFor="budget-runs">
          <Input
            id="budget-runs"
            type="number"
            min={0}
            className="w-40"
            placeholder={t('unlimitedPlaceholder')}
            value={runs}
            disabled={!canWrite || pending}
            onChange={(e) => setRuns(e.target.value)}
          />
        </SettingsRow>
      </SettingsList>

      <p className="text-[12px] text-muted-foreground">
        {t('usageNow', { runs: usage.runs, usd: usage.usd.toFixed(2), tokens: usage.tokens })}
      </p>

      {canWrite && (
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={pending} onClick={onSave}>
            {pending ? t('saving') : t('save')}
          </Button>
          {saved && !pending && (
            <span className="text-[12px] text-muted-foreground">{t('saved')}</span>
          )}
        </div>
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
