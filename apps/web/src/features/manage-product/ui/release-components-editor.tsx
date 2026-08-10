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

// 이 릴리즈가 무엇을 내보내는가 — 프로덕트가 추적하는 서비스별로 "나가는 버전"을 원장에서 고른다.
//
// 자유 입력이 아닌 이유: 버전은 우리가 만드는 값이 아니라 GitHub 이 이미 발행한 사실이고, 손으로 치면
// 원장의 어느 행과도 이어지지 않는 문자열이 릴리즈에 박힌다. 그래서 선택지는 임포트된 버전뿐이다.
//
// "포함"과 "버전"이 별개인 이유: 계획 단계에서는 "이 서비스는 이번에 나간다, 버전은 아직"이 진짜 상태다.
// 포함시키는 것이 사람의 결정이고, 버전은 그때 원장 최신값으로 채워 주되 바꿀 수 있다 — 아무도 고르지
// 않은 버전이 계획에 박히는 것보다, 채워진 값을 고치는 편이 언제나 낫다.
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
  // 값이 아니라 고른 행을 들고 있는다 — 저장할 때 versionRecordId 를 같이 보내야 "어느 v1.0.0 이었나"가
  // 나중에 답이 되기 때문이다(같은 서비스 이름이 두 스트림을 가리킬 수 있다).
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

  // 서비스별 임포트 버전 — 원장은 publishedAt 내림차순으로 오지만, 순서를 신뢰하지 않고 여기서 다시 세운다.
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

  // 고른 행 → 저장할 형태. 버전 문자열은 사람이 읽는 값이고, 행 id 가 정체성이다.
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
      // 포함시키는 순간 원장 최신 행으로 채운다 — 없으면 "미정"으로 남는다(아직 안 나온 서비스).
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
                  // 값은 행 id — 같은 버전 문자열이 두 스트림에 있을 수 있으므로, 고른 것이 무엇인지
                  // 애초에 유일하게 식별되는 값으로 다룬다.
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
