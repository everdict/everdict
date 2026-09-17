import { describe, expect, it } from 'vitest'

import { issueCommitUrl, issueLinkHref, issueLinkIsExternal, parseIssueCommitRef } from './link-target'

// ── THE ONE LINK TARGET THAT IS NOT OURS ─────────────────────────────────────────────────────────────
//
// Every other kind resolves to a route in this workspace, so `issueLinkHref` could be a lookup in a table.
// A commit lives on the forge, and the two things that can quietly be wrong about that address are the host
// (github.com for a GitHub Enterprise workspace is not a broken link — it is a link to a DIFFERENT
// repository, which may well exist and belong to somebody else) and the shape of the route itself.
describe('a commit link addresses the forge', () => {
  it('builds the github.com address when no host is set', () => {
    expect(
      issueCommitUrl({
        id: 'e4fe66e8bfcbebc342115226033654cd2280f07b',
        repository: 'PPP-Atelier/digo-mobile',
      })
    ).toBe(
      'https://github.com/PPP-Atelier/digo-mobile/commit/e4fe66e8bfcbebc342115226033654cd2280f07b'
    )
  })

  it('uses the Enterprise host when one is set', () => {
    expect(issueCommitUrl({ id: 'abc1234', repository: 'acme/app', host: 'ghe.internal' })).toBe(
      'https://ghe.internal/acme/app/commit/abc1234'
    )
  })

  it('has no address without a repository', () => {
    expect(issueCommitUrl({ id: 'abc1234' })).toBeUndefined()
  })

  it('is what issueLinkHref answers for a commit, and it leaves the workspace', () => {
    expect(issueLinkHref('acme', 'commit', 'abc1234', undefined, { repository: 'acme/app' })).toBe(
      'https://github.com/acme/app/commit/abc1234'
    )
    expect(issueLinkIsExternal('commit')).toBe(true)
  })

  // The sibling kinds must keep answering with a route — a commit is an exception to that rule, and an
  // exception that swallowed its neighbours would send every link on the screen to github.com.
  it('leaves every other kind on its route here', () => {
    expect(issueLinkHref('acme', 'harness', 'browser-suite')).toBe('/acme/harness/browser-suite')
    expect(issueLinkHref('acme', 'case', 'c1', 'terminal-bench')).toBe('/acme/dataset/terminal-bench')
    expect(issueLinkIsExternal('issue')).toBe(false)
  })
})

// ── WHAT A MEMBER ACTUALLY PASTES ───────────────────────────────────────────────────────────────────
describe('a pasted commit address is decomposed by one owner', () => {
  it('reads a github.com commit URL', () => {
    expect(
      parseIssueCommitRef(
        'https://github.com/PPP-Atelier/digo-mobile/commit/e4fe66e8bfcbebc342115226033654cd2280f07b'
      )
    ).toEqual({
      repository: 'PPP-Atelier/digo-mobile',
      sha: 'e4fe66e8bfcbebc342115226033654cd2280f07b',
    })
  })

  it('keeps an Enterprise host and drops github.com', () => {
    expect(parseIssueCommitRef('https://ghe.internal/acme/app/commit/abc1234')).toEqual({
      repository: 'acme/app',
      sha: 'abc1234',
      host: 'ghe.internal',
    })
  })

  it('survives the query and fragment a browser leaves on a copied address', () => {
    expect(parseIssueCommitRef('https://github.com/acme/app/commit/ABC1234?diff=split#files')).toEqual({
      repository: 'acme/app',
      sha: 'abc1234',
    })
  })

  it('reads the shorthand people type', () => {
    expect(parseIssueCommitRef('acme/app@ABC1234')).toEqual({ repository: 'acme/app', sha: 'abc1234' })
  })

  // An issue URL and a commit URL differ by one path segment, and pasting the wrong one is the likeliest
  // mistake at this field — so it is a refusal rather than a link to a sha that is actually an issue number.
  it('answers undefined for anything that is not a commit address', () => {
    for (const input of [
      'https://github.com/acme/app/issues/12',
      'https://github.com/acme/app',
      'acme/app',
      'e4fe66e',
      '',
    ])
      expect(parseIssueCommitRef(input)).toBeUndefined()
  })
})
