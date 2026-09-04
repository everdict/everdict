'use server'

import { authContext } from '@/shared/auth/principal'

import { loadIssueViewData, type IssueViewData, type IssueViewRequest } from './issue-view-data'

// What the screen re-fetches when the view changes — **the list alone**. The route is not re-rendered, so the header, toolbar and
// directories (members, projects, labels) stay where they are and the round trips that read them do not happen again.
//
// The client may assemble and send the narrowing for the same reason as "show more": authorization is still the CONTROL PLANE's.
// This request goes out with the signed-in person's token, and workspace and team visibility are applied again by the server.
//
// Failures are returned as VALUES rather than thrown — an interaction in one corner of a list must not blow the whole page into an error boundary.
export async function loadIssueViewAction(request: IssueViewRequest): Promise<IssueViewData> {
  const ctx = await authContext()
  try {
    return await loadIssueViewData(ctx, request)
  } catch (e) {
    return {
      groups: [],
      droppedGroups: 0,
      error: { kind: 'load', message: e instanceof Error ? e.message : String(e) },
    }
  }
}
