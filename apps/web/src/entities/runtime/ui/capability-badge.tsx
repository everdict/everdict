'use client'

import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'

import { capabilityFit, missingCapabilities } from '../model/capability-fit'

// Compact runtime↔harness fit badge for the submit-time runtime picker options. Renders only when there's a definite
// verdict — a service (topology) harness plus a runtime that declares capabilities: green when it fits, red "needs <cap>"
// when a required capability is missing. Command/process harnesses (no requirement) and capability-less runtimes → null.
export function CapabilityBadge({
  harnessKind,
  capabilities,
}: {
  harnessKind: string | undefined
  capabilities: string[] | undefined
}) {
  const t = useTranslations('runtimeFit')
  const fit = capabilityFit(capabilities, harnessKind)
  if (fit === 'fit') return <Badge tone="success">{t('fits')}</Badge>
  if (fit === 'unfit')
    return (
      <Badge tone="danger">
        {t('missing', { caps: missingCapabilities(capabilities, harnessKind).join(', ') })}
      </Badge>
    )
  return null
}

// A note below the picker for the CURRENTLY SELECTED runtime — surfaced only when it definitely can't run the chosen
// harness (the badge is hidden once the dropdown closes). Warn-tone; the control plane is the final gate at dispatch.
export function CapabilityFitNote({
  harnessKind,
  capabilities,
}: {
  harnessKind: string | undefined
  capabilities: string[] | undefined
}) {
  const t = useTranslations('runtimeFit')
  if (capabilityFit(capabilities, harnessKind) !== 'unfit') return null
  return (
    <Callout tone="warning">
      {t('note', { caps: missingCapabilities(capabilities, harnessKind).join(', ') })}
    </Callout>
  )
}
