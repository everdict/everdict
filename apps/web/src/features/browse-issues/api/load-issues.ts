'use server'

import { issuePageSchema, type IssuePage } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import type { IssuePageQuery } from '../model/page-query'

// One group's next page. A grouped screen gives each group its own page, so "show more" is per group too — rather than redrawing everything,
// rows are appended to THAT group (the same path as Linear's in-group show more).
//
// Failures are returned rather than thrown: a button in one corner of a list must not blow the whole page into an error boundary, and the
// reason has to be readable right there.
export async function loadIssuePageAction(
  query: IssuePageQuery
): Promise<{ ok: true; page: IssuePage } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    return { ok: true, page: issuePageSchema.parse(await controlPlane.listIssues(ctx, query)) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
