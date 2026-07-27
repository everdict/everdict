'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import type { BudgetLimit, BudgetUsage } from '@/entities/budget'
import type { TenantUsage, UsageItem } from '@/entities/usage'
import { fmtTokens, fmtUsd } from '@/shared/lib/format'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { StatCard } from '@/shared/ui/stat-card'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
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
  metered,
  canWrite,
}: {
  usage: BudgetUsage
  limit: BudgetLimit | null
  metered?: TenantUsage // metered billing usage (GET /usage) — the LLM cost surface, shown read-only under the limits
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

  // Itemized (source × model) breakdown — drop empty/legacy-unattributed lines, heaviest spend first.
  const items = (metered?.items ?? [])
    .filter((i) => i.usd > 0 || i.tokens > 0 || i.evaluations > 0)
    .sort((a, b) => b.usd - a.usd)
  const sourceLabel = (s: UsageItem['source']) =>
    s === 'harness' ? t('sourceHarness') : s === 'judge' ? t('sourceJudge') : t('sourceAgent')

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

      {canWrite ? (
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={pending} onClick={onSave}>
            {pending ? t('saving') : t('save')}
          </Button>
          {saved && !pending && (
            <span className="text-[12px] text-muted-foreground">{t('saved')}</span>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">{t('readOnly')}</p>
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {metered && (
        <div className="space-y-2 pt-2">
          <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
            {t('meteredTitle')}
            <InfoTip content={t('meteredTip')} />
          </h3>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label={t('meteredCost')} value={fmtUsd(metered.usd)} />
            <StatCard label={t('meteredTokens')} value={fmtTokens(metered.tokens)} />
            <StatCard
              label={t('meteredEvaluations')}
              value={metered.evaluations.toLocaleString()}
            />
          </div>
          {items.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <h4 className="flex items-center gap-1.5 text-[12px] font-[560] text-muted-foreground">
                {t('breakdownTitle')}
                <InfoTip content={t('breakdownTip')} />
              </h4>
              <Table>
                <THead>
                  <TR>
                    <TH>{t('colModel')}</TH>
                    <TH>{t('colActivity')}</TH>
                    <TH className="text-right">{t('colCost')}</TH>
                    <TH className="text-right">{t('colTokens')}</TH>
                    <TH className="text-right">{t('colEvaluations')}</TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((i) => (
                    <TR key={`${i.source} ${i.model}`}>
                      <TD className="font-[510]">{i.model || t('modelUnattributed')}</TD>
                      <TD className="text-muted-foreground">{sourceLabel(i.source)}</TD>
                      <TD className="text-right tabular-nums">{fmtUsd(i.usd)}</TD>
                      <TD className="text-right tabular-nums">{fmtTokens(i.tokens)}</TD>
                      <TD className="text-right tabular-nums">{i.evaluations.toLocaleString()}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
