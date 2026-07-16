import { sortSemverDesc } from '@/shared/lib/semver'
import type { ComboboxOption } from '@/shared/ui/combobox'

// Version options for a version picker — the 'latest' alias (at top, with the resolved result + tags as hint) +
// registered versions (newest semver first, tags as hint when present). Shared by every wizard that picks a
// harness/dataset version (run · scorecard · schedule) — one source of truth instead of per-form copies.
// versionTags = version → free-form labels (only versions that have tags). Identify versions that are hard to
// tell apart by number alone via their tags.
export function versionOptions(
  versions: string[],
  versionTags?: Record<string, string[]>
): ComboboxOption[] {
  const sorted = sortSemverDesc(versions)
  const latest = sorted[0]
  const latestTags = latest ? (versionTags?.[latest] ?? []) : []
  return [
    {
      value: 'latest',
      label: 'latest',
      hint: latest
        ? `→ ${latest}${latestTags.length > 0 ? ` · ${latestTags.join(' · ')}` : ''}`
        : undefined,
    },
    ...sorted.map((v) => {
      const tags = versionTags?.[v] ?? []
      return { value: v, ...(tags.length > 0 ? { hint: tags.join(' · ') } : {}) }
    }),
  ]
}
