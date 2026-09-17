import type { IssueLinkType } from '../model/schema'

// Where a link points. A link is an UNVALIDATED pointer, so its target may 404 — that is the price of "an asset can be referenced before
// (or after) it exists". Kept in one place so every screen that draws a link (the attribute panel, the history) uses the same address.
// Each entry addresses ONE thing, so each is the singular segment — the collection's plural (`/harnesses`) is a
// different address holding a different screen.
const ROUTE: Record<IssueLinkType, string> = {
  harness: 'harness',
  dataset: 'dataset',
  judge: 'judge',
  scorecard: 'scorecard',
  run: 'run',
  view: 'view',
  // When one issue mentioned another — the link holds a UUID, and the detail route resolves it to the canonical identifier address.
  // A screen that knows the title too builds the slugged address with `issueHref`.
  issue: 'issue',
  // The product timeline — a link points at one product or one release (singular detail routes).
  product: 'product',
  release: 'release',
  // A case has no page of its own; it lives on its dataset's. `issueLinkHref` takes the dataset for it.
  case: 'dataset',
  // A commit has no page HERE at all — it lives on the forge, and `issueLinkHref` returns that address rather
  // than a route. The entry exists so the map stays total: a kind added without an answer here is a compile
  // error rather than a link to `/undefined/`.
  commit: '',
}

// The kinds the issue detail shows and can attach as a "linked asset" — the three **capabilities that VERIFY** the issue, and nothing else.
// The link model itself keeps all six kinds (the control plane and MCP still accept every one). Only the SCREEN narrows, because:
//  - `scorecard` is EVIDENCE rather than a capability. A scorecard pinned to an issue is already owned by the "evaluation history" section
//    (the pinned badge plus the baseline badge) and the resolution record shows the baseline, so a chip here too puts the same thing on one
//    screen twice and blurs which of them is canonical.
//  - `run` and `view` do not answer "what is this issue verified BY".
export const ISSUE_CAPABILITY_LINK_TYPES = [
  'harness',
  'dataset',
  'judge',
] as const satisfies readonly IssueLinkType[]

// The kinds the attribute column can pick and attach. A subset of the link vocabulary, so it is DERIVED from the array above — written
// twice, what the screen draws and what can be picked would diverge.
export type IssueCapabilityLinkType = (typeof ISSUE_CAPABILITY_LINK_TYPES)[number]

// A **mention** rather than a capability. The three capability rows answer a fixed question ("what verifies this issue"), so each kind gets
// its own row; a mention is not that question but a free cross-reference — so ONE row takes the kind as a parameter.
// Today that is `issue` alone (a user decision: issue↔issue first). Turning on run or view is one line in this array plus one place that
// reads that kind's candidates, and `scorecard` does not come in here — a scorecard is evidence and the "evaluation history"
// section already owns it (the same thing is never drawn twice on one screen).
export const ISSUE_MENTION_LINK_TYPES = ['issue'] as const satisfies readonly IssueLinkType[]
export type IssueMentionLinkType = (typeof ISSUE_MENTION_LINK_TYPES)[number]

// `commit` is a mention too, and it is NOT in the array above, because that array's whole meaning is "kinds one
// picker control can take as a parameter". A commit is not picked: it has no candidate list here — the change
// exists in somebody's repository whether or not this workspace has heard of it — so it is typed or pasted,
// which is a different control. Putting it in that array would have compiled and rendered an issue picker
// offering to attach an issue as a commit.

// EntityRef distinguishes by colour only the three kinds that HAVE versions — the rest render as an ordinary id@version reference.
export const ISSUE_LINK_REF_KIND: Partial<Record<IssueLinkType, 'dataset' | 'harness' | 'judge'>> =
  {
    dataset: 'dataset',
    harness: 'harness',
    judge: 'judge',
  }

// WHERE A COMMIT LINK POINTS — the one link target that is not ours.
//
// This lives in the web rather than in `@everdict/contracts` beside the coordinates rule, because the web may
// import that package TYPE-ONLY (`pnpm web-imports`, the zod-v3/v4 isolation): a renderer over there could not
// be called by the only thing that renders one. So the rule that DECIDES a commit link (`issueLinkDefects`,
// `sameIssueLink`) is shared, and the two functions that only ever serve this screen are here, once.
export function issueCommitUrl(link: {
  id: string
  repository?: string
  host?: string
}): string | undefined {
  if (link.repository === undefined) return undefined
  const origin =
    link.host === undefined ? 'https://github.com' : `https://${link.host.replace(/^https?:\/\//, '')}`
  return `${origin}/${link.repository}/commit/${link.id.trim().toLowerCase()}`
}

// The paste affordance: a member copies a commit's address out of the browser, not an `owner/name` and a sha
// typed separately. Accepted are that URL (github.com or an Enterprise host) and the shorthand `owner/name@sha`.
// Returns undefined rather than throwing — an issue URL and a commit URL differ by one path segment, so the
// likeliest wrong paste has to be answerable as "not a commit address" rather than as a crash.
export function parseIssueCommitRef(
  input: string
): { repository: string; sha: string; host?: string } | undefined {
  const text = input.trim()
  const url = /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/commits?\/([0-9a-fA-F]{7,64})(?:[?#].*)?$/.exec(text)
  if (url) {
    const [, host, repository, sha] = url
    if (host === undefined || repository === undefined || sha === undefined) return undefined
    return {
      repository: repository.replace(/\.git$/, ''),
      sha: sha.toLowerCase(),
      ...(host === 'github.com' || host === 'www.github.com' ? {} : { host }),
    }
  }
  const shorthand = /^([^/\s@]+\/[^/\s@]+)@([0-9a-fA-F]{7,64})$/.exec(text)
  if (shorthand) {
    const [, repository, sha] = shorthand
    if (repository === undefined || sha === undefined) return undefined
    return { repository, sha: sha.toLowerCase() }
  }
  return undefined
}

export function issueLinkHref(
  workspace: string,
  type: IssueLinkType,
  id: string,
  dataset?: string,
  commit?: { repository?: string; host?: string }
): string {
  // A commit is the one target outside the workspace: the address is the forge's, built by the same function
  // the control plane and the history use (`issueCommitUrl`), so the chip and the API name one URL.
  if (type === 'commit') {
    const url = issueCommitUrl({ id, ...commit })
    // A commit link without a repository cannot exist — `issueLinkDefects` refuses one at every door. If a row
    // from before that rule somehow reaches here, the workspace root is a page that exists, which is the one
    // thing `/${workspace}//${sha}` would not be.
    return url ?? `/${workspace}`
  }
  // A case link points at its DATASET's page — the case id alone is not an address.
  const target = type === 'case' ? (dataset ?? id) : id
  return `/${workspace}/${ROUTE[type]}/${encodeURIComponent(target)}`
}

// An href that leaves the workspace opens in a new tab, and the chip needs to know which ones do.
export function issueLinkIsExternal(type: IssueLinkType): boolean {
  return type === 'commit'
}
