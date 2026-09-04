import 'server-only'

import { issuePageSchema, type IssueSummary } from '@/entities/issue'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

// The issues that reference this capability — the first place the reverse query the control plane already had
// (`GET /issues?linkType=&linkId=`) is used. A link is stored only on the ISSUE side, so answering "why does this judge exist" from the judge's
// screen can only be done by asking in this direction.
//
// An older asset with no origin stamp is caught by this query too — as long as somebody (or an agent) attached the link on an issue. So an
// existing asset can show its issues with no retroactive backfill.
//
// It is supporting information, so the detail still renders on failure (as an empty list).
const MAX_LINKED_ISSUES = 20

export async function loadLinkedIssues(
  ctx: AuthContext,
  linkType: 'harness' | 'dataset' | 'judge',
  linkId: string
): Promise<IssueSummary[]> {
  return controlPlane
    .listIssues(ctx, { linkType, linkId, limit: MAX_LINKED_ISSUES })
    .then((r) => issuePageSchema.parse(r).items)
    .catch((): IssueSummary[] => [])
}
