import 'server-only'

import { cookies } from 'next/headers'

import { ACTIVE_WORKSPACE_COOKIE, ACTIVE_WORKSPACE_MAX_AGE } from './workspace-scope'

// The authority for the active workspace is the URL's first segment (injected as a header by middleware). This cookie persists the most-recent
// workspace and is used for the root (/) redirect and the control plane's default fallback (middleware syncs it on every /{workspace}/* visit).
// create/accept actions pre-plant this cookie just before the redirect to prevent flicker.

export async function getActiveWorkspace(): Promise<string | undefined> {
  return (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value
}

// Callable only from server actions / route handlers (cookie write).
export async function setActiveWorkspace(id: string): Promise<void> {
  ;(await cookies()).set(ACTIVE_WORKSPACE_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ACTIVE_WORKSPACE_MAX_AGE,
  })
}
