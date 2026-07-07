'use client'

import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Combobox } from '@/shared/ui/combobox'

// Version selection on the harness detail — navigates via ?v= (the server fetches that version). However many versions there are,
// it condenses to a single dropdown (no listing every chip). When there are many options, the Combobox auto-enables search (over 7). latest on top.
// A compact control placed at the right of the page header — no label, aria-label only (the value itself is vX.Y.Z, so it's self-evident).
export function HarnessVersionSwitcher({
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
  const t = useTranslations('harnessVersions')
  if (versions.length === 0) return null
  return (
    <Combobox
      id="harness-version-switch"
      aria-label={t('versionsAria', { count: versions.length })}
      value={current}
      onChange={(v) =>
        router.push(`/${workspace}/harnesses/${encodeURIComponent(id)}?v=${encodeURIComponent(v)}`)
      }
      options={[...versions].reverse().map((v) => {
        const tags = versionTags?.[v]
        return {
          value: v,
          label: v === latest ? `${v} · latest` : v,
          ...(tags && tags.length > 0 ? { hint: tags.join(' · ') } : {}),
        }
      })}
      className="w-40"
    />
  )
}
