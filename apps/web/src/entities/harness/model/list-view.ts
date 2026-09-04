import type { ListDisplay, ListViewSpec } from '@/shared/lib/list-view'

import type { Harness } from './schema'

// What the harness list knows about itself — which axes it filters on, how it groups, and what it sorts by. The vocabulary lives here because
// the list screen and the address parsing have to use the SAME words (an unknown axis is dropped from the address).
//
// Team being one of the axes is this list's central change. Team was a PATH for a while (`…/team/ENG/harnesses`), but people do not look for
// "our team's harnesses" on a team screen — they narrow to them from the harness list.
export const HARNESS_FACETS = ['category', 'kind', 'creator', 'tag'] as const
export const HARNESS_GROUPINGS = [
  'none',
  'template',
  'category',
  'kind',
  'team',
  'creator',
] as const
export const HARNESS_ORDERS = ['name', 'updated', 'created', 'versions'] as const

// The default is grouping by shape (template) — a variation differing in one env value or one model is not an unrelated harness but a SIBLING
// on one shape, and without looking that way the list becomes "twelve similarly named things".
export const DEFAULT_HARNESS_DISPLAY: ListDisplay = { grouping: 'template', order: 'name' }

function versionsOf(harness: Harness): number {
  return harness.versionCount ?? harness.versions.length
}

// The labels a harness is called by = the union of its version tags (newest version first, deduplicated). This is the answer to "with many
// harnesses, the names alone do not say what each one is" — a label a person attached, to whichever version, stays that harness's name plate
// in the list (only the newest is NOT used, so an older version's label does not disappear when a new version is stamped).
// Filter-only for the same reason as datasets: several can be held, so grouping by it would make the groups sum to more than the list.
export function harnessTags(harness: Harness): string[] {
  const byVersion = harness.versionTags
  if (!byVersion) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const version of [...harness.versions].reverse()) {
    for (const tag of byVersion[version] ?? []) {
      if (!seen.has(tag)) {
        seen.add(tag)
        tags.push(tag)
      }
    }
  }
  return tags
}

export const harnessListSpec: ListViewSpec<Harness> = {
  facetValues: (harness, facet) => {
    switch (facet) {
      case 'category':
        return harness.category === undefined ? [] : [harness.category]
      case 'kind':
        return harness.kind === undefined ? [] : [harness.kind]
      case 'creator':
        return harness.createdBy === undefined ? [] : [harness.createdBy]
      case 'tag':
        return harnessTags(harness)
      default:
        return []
    }
  },
  // What a search sweeps is every name a person might call that harness by — not just the id, but the subtitle (model, command),
  // the shape, and the version tags a person attached themselves.
  searchText: (harness) =>
    [
      harness.id,
      harness.category ?? '',
      harness.kind ?? '',
      harness.subtitle ?? '',
      harness.templateId ?? '',
      ...harnessTags(harness),
    ].join(' '),
  groupKey: (harness, grouping) => {
    switch (grouping) {
      case 'template':
        return harness.templateId ?? null
      case 'category':
        return harness.category ?? null
      case 'kind':
        return harness.kind ?? null
      case 'creator':
        return harness.createdBy ?? null
      default:
        return null
    }
  },
  compare: (a, b, order) => {
    switch (order) {
      case 'updated':
        return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
      case 'created':
        return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
      case 'versions':
        return versionsOf(b) - versionsOf(a)
      default:
        return a.id.localeCompare(b.id)
    }
  },
}
