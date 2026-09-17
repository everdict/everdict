import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'
import ko from '../../../../messages/ko.json'

// The entry the report asked for: an issue that exists here had no way to name the GitHub issue it is about.
// `github` used to be attached by IMPORT alone — the detail screen could DETACH a link it could not make.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }))
vi.mock('@/features/manage-ci-links', () => ({
  listGithubAppReposAction: async () => ({ ok: true, repos: [] }),
}))
vi.mock('../api/import-github-issues', () => ({
  attachIssueGithubAction: async () => ({ ok: true }),
  listImportCandidatesAction: async () => ({ ok: true, candidates: [] }),
}))

const { LinkGithubIssueButton } = await import('./link-github-issue-button')

const render = (locale: 'en' | 'ko'): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={locale === 'en' ? en : ko}>
      <LinkGithubIssueButton workspace="acme" issueId="i1" />
    </NextIntlClientProvider>
  )

describe('link GitHub issue entry', () => {
  it('offers the link from the issue detail', () => {
    expect(render('en')).toContain('Link a GitHub issue')
  })

  // A missing catalog entry renders as the key PATH and nothing but a browser console says so — which is why
  // the copy is asserted per locale rather than trusted to a single lookup (see shared/i18n/catalog-icu.test).
  it('is written in both locales, not only the one the developer reads', () => {
    for (const locale of ['en', 'ko'] as const) {
      expect(render(locale)).not.toContain('linkGithubIssue.')
    }
  })
})
