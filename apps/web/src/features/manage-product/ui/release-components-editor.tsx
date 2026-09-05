'use client'

import { useMemo, useState } from 'react'
import { Check, Loader2, Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { ProductService, ProductVersion, ReleaseComponent } from '@/entities/product'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'

import { updateReleaseAction } from '../api/products'

// What this release ships — for each service the product tracks, the "version going out" is PICKED from the ledger.
//
// Why not free input: a version is not a value we make but a fact GitHub already published, and typed by hand it pins a string into the
// release that joins to no ledger row at all. So the only choices are imported versions.
//
// Why "included" and "version" are separate: at the planning stage "this service ships this time, version not yet" is the REAL state.
// Including it is the person's decision, and the version is then filled from the ledger's newest but stays changeable — correcting a filled
// value always beats pinning a version nobody chose into the plan.
export function ReleaseComponentsEditor({
  releaseId,
  services,
  versions,
  components,
  canEdit,
}: {
  releaseId: string
  services: ProductService[]
  versions: ProductVersion[]
  components?: ReleaseComponent[]
  canEdit: boolean
}) {
  const t = useTranslations('releasePage')
  const refresh = useRefresh()
  // It holds the chosen ROW rather than the value — the versionRecordId has to be sent on save for "which v1.0.0 was it" to have an answer
  // later (the same service name can point at two streams).
  const [rows, setRows] = useState<
    Record<string, { version?: string; versionRecordId?: string } | undefined>
  >(() =>
    Object.fromEntries(
      (components ?? []).map((row) => [
        row.service,
        {
          ...(row.version !== undefined ? { version: row.version } : {}),
          ...(row.versionRecordId !== undefined ? { versionRecordId: row.versionRecordId } : {}),
        },
      ])
    )
  )
  const [pending, setPending] = useState(false)

  // The imported versions per service — the ledger arrives in publishedAt descending order, but the order is not trusted and is re-established here.
  const byService = useMemo(() => {
    const map = new Map<string, ProductVersion[]>()
    for (const version of versions) {
      const list = map.get(version.service) ?? []
      list.push(version)
      map.set(version.service, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    return map
  }, [versions])

  const included = (service: string): boolean => Object.hasOwn(rows, service)

  // The chosen row → the shape to save. The version string is what a person READS; the row id is the identity.
  const pick = (
    row?: ProductVersion
  ): { version?: string; versionRecordId?: string } | undefined =>
    row === undefined ? undefined : { version: row.version, versionRecordId: row.id }

  function toggle(service: string) {
    setRows((current) => {
      if (Object.hasOwn(current, service)) {
        const { [service]: _removed, ...rest } = current
        return rest
      }
      // Including it fills from the ledger's newest row — with none, it stays "undecided" (a service that has not shipped yet).
      return { ...current, [service]: pick(byService.get(service)?.[0]) }
    })
  }

  function fillLatest() {
    setRows(
      Object.fromEntries(
        services.map((service) => [service.name, pick(byService.get(service.name)?.[0])])
      )
    )
  }

  function save() {
    void (async () => {
      setPending(true)
      try {
        const components = services
          .filter((service) => included(service.name))
          .map((service) => ({
            service: service.name,
            ...(rows[service.name]?.version !== undefined
              ? { version: rows[service.name]?.version }
              : {}),
            ...(rows[service.name]?.versionRecordId !== undefined
              ? { versionRecordId: rows[service.name]?.versionRecordId }
              : {}),
          }))
        const r = await updateReleaseAction(releaseId, { components })
        if (!r.ok) {
          toast.error(r.error ?? t('componentsError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  if (services.length === 0) return null

  return (
    <div className="space-y-2">
      {services.map((service) => {
        const options = byService.get(service.name) ?? []
        const on = included(service.name)
        return (
          <div
            key={service.name}
            className={cn(
              'flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5',
              on ? 'border-primary/40 bg-primary/5' : 'border-border'
            )}
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={!canEdit}
              onClick={() => toggle(service.name)}
              className="flex items-center gap-2 disabled:cursor-not-allowed"
            >
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-[4px] border',
                  on ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                )}
              >
                {on && <Check className="size-3" />}
              </span>
              <span className="text-sm font-[510]">{service.name}</span>
            </button>
            {service.path !== undefined && (
              <span className="font-mono text-[11px] text-muted-foreground">/{service.path}</span>
            )}
            <div className="ml-auto w-52">
              <Combobox
                options={[
                  { value: '', label: t('componentUndecided') },
                  // The value is the ROW ID — the same version string can exist in two streams, so what was chosen is handled as the value
                  // that uniquely identifies it in the first place.
                  ...options.map((version) => ({
                    value: version.id,
                    label: version.version,
                    hint: version.publishedAt.slice(0, 10),
                  })),
                ]}
                value={rows[service.name]?.versionRecordId ?? ''}
                onChange={(value) =>
                  setRows((current) => ({
                    ...current,
                    [service.name]:
                      value === '' ? undefined : pick(options.find((row) => row.id === value)),
                  }))
                }
                disabled={!canEdit || !on}
                searchable
                placeholder={t('componentUndecided')}
                aria-label={t('componentVersionFor', { service: service.name })}
              />
            </div>
          </div>
        )
      })}
      {canEdit && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={fillLatest}>
            <Sparkles className="size-3.5" />
            {t('componentsFillLatest')}
          </Button>
          <Button size="sm" onClick={save} disabled={pending}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {t('componentsSave')}
          </Button>
        </div>
      )}
    </div>
  )
}
