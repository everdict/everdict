'use server'

import { cookies } from 'next/headers'

import { ISSUE_DISPLAY_COOKIE, issueDisplaySchema, withIssueDisplay } from '@/entities/issue'

// Remember how this reader wants one list drawn. A display option changes nothing about WHICH issues the list
// holds, so it is a per-user preference (a sibling of theme, locale and timezone) rather than something the
// address carries — see `entities/issue/model/display.ts` for why the store is a cookie and not localStorage.
//
// The caller does not re-render: the menu refreshes the route itself, which re-runs the server component with
// the new cookie. Nothing is revalidated globally, because nothing about the DATA changed.
export async function setIssueDisplay(viewKey: string, display: unknown): Promise<void> {
  // A server action is an external boundary — the argument arrives from the browser, so it is parsed rather
  // than trusted. A malformed display is dropped: the reader keeps whatever they had.
  const parsed = issueDisplaySchema.safeParse(display)
  if (!parsed.success || viewKey === '') return
  const store = await cookies()
  const next = withIssueDisplay(store.get(ISSUE_DISPLAY_COOKIE)?.value, viewKey, parsed.data)
  store.set(ISSUE_DISPLAY_COOKIE, next, {
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
    sameSite: 'lax',
  })
}
