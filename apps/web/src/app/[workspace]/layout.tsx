import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { ShellSwitch } from '@/widgets/app-shell'
import { currentPrincipal } from '@/shared/auth/principal'
import { keycloakConfigured } from '@/shared/config/env'

export const dynamic = 'force-dynamic'

// The URL's first segment is the active workspace (Linear-style /{workspace}/...). The middleware injects it as a header and
// currentPrincipal returns a Principal scoped to that workspace. This layout is the authoritative validator.
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ workspace: string }>
}) {
  const { workspace: slug } = await params
  const { principal } = await currentPrincipal()

  // Auth-exchange failure (token rejected 401 / control plane down) → no authoritative workspace·role → re-login.
  // Set callbackUrl explicitly to this workspace to block the loop that returns to a stale callbackUrl=`/` in the cookie.
  if (!principal) redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(`/${slug}`)}`)

  // If there are no workspaces at all, onboarding (create the first workspace). The app always operates within ≥1 workspace.
  if ((principal.workspaces?.length ?? 0) === 0) redirect('/onboarding')

  // If not a member of the URL's workspace (stale link / left workspace, etc.), go to my default workspace.
  // (The control plane falls a non-member selection back to the default, so principal.workspace is always a valid membership.)
  const isMember = principal.workspaces?.some((w) => w.id === slug) ?? false
  if (!isMember) redirect(`/${principal.workspace}`)

  // Infra split view: the infra panel hosts the REAL routed pages in a same-origin iframe → render them
  // chrome-less. The server hint is sec-fetch-dest=iframe (sent only on trustworthy origins) OR the panel's
  // explicit ?embed=1 (promoted to x-everdict-embed by the middleware); ShellSwitch (client) makes the framed
  // decision STICKY, because this dynamic layout re-renders on soft navigation without those signals.
  const requestHeaders = await headers()
  const embedHint =
    requestHeaders.get('sec-fetch-dest') === 'iframe' ||
    requestHeaders.get('x-everdict-embed') === '1'

  return (
    <ShellSwitch
      embedHint={embedHint}
      workspace={principal.workspace}
      workspaces={principal.workspaces ?? []}
      subject={principal.subject}
      roles={principal.roles}
      authed={principal.via === 'oidc'}
      showLogin={keycloakConfigured}
      {...(principal.email !== undefined ? { email: principal.email } : {})}
      {...(principal.profile !== undefined ? { profile: principal.profile } : {})}
    >
      {children}
    </ShellSwitch>
  )
}
