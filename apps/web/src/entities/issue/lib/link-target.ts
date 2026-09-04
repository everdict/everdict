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

// EntityRef distinguishes by colour only the three kinds that HAVE versions — the rest render as an ordinary id@version reference.
export const ISSUE_LINK_REF_KIND: Partial<Record<IssueLinkType, 'dataset' | 'harness' | 'judge'>> =
  {
    dataset: 'dataset',
    harness: 'harness',
    judge: 'judge',
  }

export function issueLinkHref(
  workspace: string,
  type: IssueLinkType,
  id: string,
  dataset?: string
): string {
  // A case link points at its DATASET's page — the case id alone is not an address.
  const target = type === 'case' ? (dataset ?? id) : id
  return `/${workspace}/${ROUTE[type]}/${encodeURIComponent(target)}`
}
