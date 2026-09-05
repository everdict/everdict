import { NextResponse } from 'next/server'

import { issuePageSchema } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The door the issue picker's search box calls. The browser never calls the control plane directly (every call is server-only), so a search that
// follows typing goes through our route — the same shape as the @-picker using `/api/agent/mentions/[type]`.
//
// The NARROWING is the control plane's (`?q=`): taking one window and filtering here starts silently failing to find things the moment the
// workspace outgrows that window — and a user cannot tell "I searched and it is not there" from "it is outside the window".
const LIMIT = 20

export async function GET(request: Request): Promise<Response> {
  const ctx = await authContext()
  const params = new URL(request.url).searchParams
  const query = params.get('q')?.trim() ?? ''
  // The issue itself is not a candidate (a link where an issue mentions itself means nothing). The calling screen knows which one.
  const exclude = new Set(params.getAll('exclude'))
  try {
    const page = issuePageSchema.parse(
      await controlPlane.listIssues(ctx, { ...(query ? { search: query } : {}), limit: LIMIT })
    )
    return NextResponse.json({
      items: page.items
        .filter((issue) => !exclude.has(issue.id))
        .map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
        })),
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
