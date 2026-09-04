import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'
import { FileSearch } from './file-search'

vi.mock('../api/search-files', () => ({ searchFilesAction: async () => ({ ok: true, matches: [] }) }))

// A workspace filesystem you can browse and cannot search is a tree you have to already know. Census:
// `/fs/search` and `/fs/usage` had no web caller at all.
// docs/architecture/web-runtime-gap-census-spec.md
describe('FileSearch', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <FileSearch />
    </NextIntlClientProvider>
  )

  it('offers BOTH inputs — the control plane searches two different things', () => {
    // Collapsing them into one box would make it lie about what it does: `glob` matches PATHS, `pattern`
    // greps CONTENT, and a user who typed a regex into a path box gets nothing with no explanation.
    expect(html).toContain(en.files.searchGlobPlaceholder)
    expect(html).toContain(en.files.searchPatternPlaceholder)
  })

  it('shows neither a result list nor a "no matches" line before anything is searched', () => {
    // An empty result and an unasked question are different states; rendering "No file matched" on load
    // answers a question nobody put.
    expect(html).not.toContain(en.files.searchNoMatches)
  })
})
