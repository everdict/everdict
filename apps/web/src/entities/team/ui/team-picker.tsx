'use client'

import { useTranslations } from 'next-intl'

import { Combobox } from '@/shared/ui/combobox'
import { Label } from '@/shared/ui/input'

// The owning-team field of a creation form — WHO the new asset will belong to. The options are the teams the
// caller can actually create into (computed by `ownerChoicesFor`, the mirror of the control plane's
// `teamForNew` gate) — offering more would be a menu of guaranteed 403s.
export interface TeamPickerOption {
  id: string
  key: string
  name: string
}

export function TeamPicker({
  id,
  teams,
  value,
  onChange,
  noneLabel,
}: {
  id: string
  teams: TeamPickerOption[]
  value: string
  onChange: (value: string) => void
  // Label for an explicit "name no team" option, for forms where leaving the choice to the control plane
  // means something different from picking one (a scorecard follows the harness's team). Absent = no such
  // option, and the empty value never reaches the submit body.
  noneLabel?: string
}) {
  const t = useTranslations('teamPicker')
  // With at most one team and no meaningful empty option there is nothing to choose — hide the field and let
  // the server's own fallback (your team, else the workspace default) file it, exactly as before the picker.
  if (teams.length === 0 || (teams.length <= 1 && noneLabel === undefined)) return null
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t('label')}</Label>
      <Combobox
        id={id}
        value={value}
        onChange={onChange}
        options={[
          ...(noneLabel !== undefined ? [{ value: '', label: noneLabel }] : []),
          ...teams.map((team) => ({ value: team.id, label: `${team.key} · ${team.name}` })),
        ]}
        searchable={false}
      />
    </div>
  )
}
