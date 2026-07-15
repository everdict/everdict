'use client'

import { useState, useTransition } from 'react'
import { ClipboardCheck, Loader2, Plug } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { probeRuntimeAction, validateRuntimeAction } from '@/features/register-runtime'
import type { RuntimeSpec } from '@/entities/runtime'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

// Detail-screen health checks for a registered runtime — reuses the register form's probe (connection) and validate (dry run)
// actions, re-POSTing the saved spec. Both are read-only (no job runs); the control plane resolves any secrets by name server-side.
export function RuntimeHealthActions({ spec }: { spec: RuntimeSpec }) {
  const t = useTranslations('registerRuntime')
  const [probe, setProbe] = useState<{ reachable?: boolean; detail?: string; error?: string }>()
  const [validation, setValidation] = useState<{
    ok?: boolean
    errors?: string[]
    missingSecrets?: string[]
    error?: string
  }>()
  const [probing, startProbe] = useTransition()
  const [validating, startValidate] = useTransition()

  function onProbe() {
    setProbe(undefined)
    startProbe(async () => {
      const r = await probeRuntimeAction(spec)
      if (r.ok) setProbe({ reachable: r.reachable, ...(r.detail ? { detail: r.detail } : {}) })
      else setProbe(r.error ? { error: r.error } : {})
    })
  }

  function onValidate() {
    setValidation(undefined)
    startValidate(async () => {
      const r = await validateRuntimeAction(spec)
      if (r.ok)
        setValidation({
          ok: true,
          ...(r.missingSecrets ? { missingSecrets: r.missingSecrets } : {}),
        })
      else
        setValidation({
          ok: false,
          ...(r.errors ? { errors: r.errors } : {}),
          ...(r.error ? { error: r.error } : {}),
        })
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          variant="secondary"
          size="sm"
          onClick={onProbe}
          disabled={probing}
          className="gap-1.5"
        >
          {probing ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
          {t('probe')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onValidate}
          disabled={validating}
          className="gap-1.5"
        >
          {validating ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ClipboardCheck className="size-3.5" />
          )}
          {t('validate')}
        </Button>
      </div>
      {probe?.reachable !== undefined && (
        <Callout tone={probe.reachable ? 'info' : 'warning'}>
          {probe.reachable ? t('probeReachable') : t('probeUnreachable')}
          {probe.detail ? ` — ${probe.detail}` : ''}
        </Callout>
      )}
      {probe?.error && (
        <Callout tone="danger" className="py-1.5">
          {t('probeFailed', { error: probe.error })}
        </Callout>
      )}
      {validation &&
        (validation.ok ? (
          validation.missingSecrets && validation.missingSecrets.length > 0 ? (
            <Callout tone="warning">
              {t('missingSecrets', { names: validation.missingSecrets.join(', ') })}
            </Callout>
          ) : (
            <Callout tone="info">{t('validationOk')}</Callout>
          )
        ) : (
          <Callout tone="danger" className="py-1.5">
            {validation.errors && validation.errors.length > 0
              ? t('validationErrors', { errors: validation.errors.join('; ') })
              : t('validationFailed', { error: validation.error ?? '' })}
          </Callout>
        ))}
    </div>
  )
}
