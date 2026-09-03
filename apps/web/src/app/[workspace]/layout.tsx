import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { ShellSwitch } from '@/widgets/app-shell'
import { currentPrincipal } from '@/shared/auth/principal'
import { keycloakConfigured } from '@/shared/config/env'
import { controlPlane } from '@/shared/lib/control-plane'
import { FrameEscape } from '@/shared/ui/frame-escape'

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
  const { principal, ctx } = await currentPrincipal()

  // Infra split view: the infra panel hosts the REAL routed pages in a same-origin iframe → render them
  // chrome-less. The server hint is sec-fetch-dest=iframe (sent only on trustworthy origins) OR the panel's
  // explicit ?embed=1 (promoted to x-everdict-embed by the middleware); ShellSwitch (client) makes the framed
  // decision STICKY, because this dynamic layout re-renders on soft navigation without those signals.
  const requestHeaders = await headers()
  const embedHint =
    requestHeaders.get('sec-fetch-dest') === 'iframe' ||
    requestHeaders.get('x-everdict-embed') === '1'

  // Auth-exchange failure (token rejected 401 / control plane down) → no authoritative workspace·role → re-login.
  // Set callbackUrl explicitly to this workspace to block the loop that returns to a stale callbackUrl=`/` in the cookie.
  // Inside the panel's iframe a plain redirect would render the sign-in flow INSIDE the panel — the middleware's
  // embed-aware 401 escape cannot see this case (the session cookie still decodes; only the control-plane
  // exchange failed), so break out of the frame here and send the WHOLE app to sign-in.
  if (!principal) {
    const signinHref = `/api/auth/signin?callbackUrl=${encodeURIComponent(`/${slug}`)}`
    if (embedHint) return <FrameEscape href={signinHref} />
    redirect(signinHref)
  }

  // If there are no workspaces at all, onboarding (create the first workspace). The app always operates within ≥1 workspace.
  if ((principal.workspaces?.length ?? 0) === 0) redirect('/onboarding')

  // If not a member of the URL's workspace (stale link / left workspace, etc.), go to my default workspace.
  // (The control plane falls a non-member selection back to the default, so principal.workspace is always a valid membership.)
  const isMember = principal.workspaces?.some((w) => w.id === slug) ?? false
  if (!isMember) redirect(`/${principal.workspace}`)

  // 사이드바의 팀 섹션(Linear 의 "Your teams") — 내가 속한 팀만. 팀 목록 조회가 곧 불변식 복구 지점이라
  // (기본팀이 없으면 서버가 만든다) 새 워크스페이스도 첫 렌더에서 팀 하나를 갖는다. 셸이 팀 때문에 죽으면
  // 안 되므로 실패는 빈 목록으로 흡수한다 — 섹션이 사라질 뿐 나머지 내비게이션은 그대로다.

  return (
    <ShellSwitch
      embedHint={embedHint}
      workspace={principal.workspace}
      workspaces={principal.workspaces ?? []}
      subject={principal.subject}
      roles={principal.roles}
      authed={principal.via === 'oidc'}
      fileExecution={principal.config?.fileExecution === true}
      showLogin={keycloakConfigured}
      {...(principal.email !== undefined ? { email: principal.email } : {})}
      {...(principal.profile !== undefined ? { profile: principal.profile } : {})}
    >
      {children}
    </ShellSwitch>
  )
}
