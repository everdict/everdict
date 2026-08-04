import { describe, expect, it } from 'vitest'

import { issueHref, issueSlug } from './href'

describe('issue address — the identifier decides, the title only describes', () => {
  it('addresses one issue with the singular segment and its identifier', () => {
    // `/{workspace}/issues` is the LIST. One issue is a different screen, so it is a different word.
    expect(issueHref('acme', 'ENG-12')).toBe('/acme/issue/ENG-12')
  })

  it('carries the title as a trailing slug, so a pasted link says what it leads to', () => {
    expect(issueHref('acme', 'ENG-12', 'The judge drops cost scores')).toBe(
      '/acme/issue/ENG-12/the-judge-drops-cost-scores'
    )
  })

  it('keeps a non-latin title instead of slugging it away to nothing', () => {
    // Stripping to ASCII would leave a Korean-titled issue with an empty slug — the address would be no worse
    // than before, but every such link would lose the one thing the slug is for.
    expect(issueHref('acme', 'ENG-12', '저지가 비용 점수를 떨어뜨린다')).toBe(
      `/acme/issue/ENG-12/${encodeURIComponent('저지가-비용-점수를-떨어뜨린다')}`
    )
  })

  it('omits the slug when a title has nothing that survives slugging', () => {
    // A trailing empty segment would read as a broken link; no slug at all is the honest address.
    expect(issueHref('acme', 'ENG-12', '!!! ???')).toBe('/acme/issue/ENG-12')
    expect(issueHref('acme', 'ENG-12', '')).toBe('/acme/issue/ENG-12')
  })

  it('cuts a long title on a word boundary rather than mid-word', () => {
    const slug = issueSlug(
      'the judge drops cost scores whenever the harness reports a total cost of exactly zero'
    )
    expect(slug.length).toBeLessThanOrEqual(64)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug.startsWith('the-judge-drops-cost-scores')).toBe(true)
  })

  it('escapes an identifier that could otherwise change the shape of the path', () => {
    expect(issueHref('acme', 'A/B-1')).toBe('/acme/issue/A%2FB-1')
  })
})
