'use client'

import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Combobox } from '@/shared/ui/combobox'

// On the detail page, choose which version's cases to view — navigates via ?version= (the server fetches that version).
// A compact control placed at the right of the page header — no label, aria-label only (the value itself is vX.Y.Z, so it's self-evident).
export function VersionSwitcher({
  id,
  versions,
  current,
  latest,
  versionTags,
}: {
  id: string
  versions: string[]
  current: string
  latest?: string
  versionTags?: Record<string, string[]> // version tags (free-form labels) — shown as a hint on the right of each option to tell numbers apart
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const t = useTranslations('datasetVersions')
  if (versions.length === 0) return null
  return (
    <Combobox
      id="version-switch"
      aria-label={t('versionAria')}
      value={current}
      onChange={(v) =>
        router.push(
          `/${workspace}/datasets/${encodeURIComponent(id)}?version=${encodeURIComponent(v)}`
        )
      }
      options={versions.map((v) => {
        const tags = versionTags?.[v]
        return {
          value: v,
          label: v === latest ? `${v} (latest)` : v,
          ...(tags && tags.length > 0 ? { hint: tags.join(' · ') } : {}),
        }
      })}
      className="w-44"
    />
  )
}
