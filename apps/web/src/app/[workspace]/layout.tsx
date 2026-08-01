import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { ShellSwitch } from '@/widgets/app-shell'
import { teamsWithSummarySchema } from '@/entities/team'
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
  let teams: { id: string; key: string; name: string; isDefault: boolean }[] = []
  try {
    const pick = (team: { id: string; key: string; name: string; isDefault: boolean }) => ({
      id: team.id,
      key: team.key,
      name: team.name,
      isDefault: team.isDefault,
    })
    teams = teamsWithSummarySchema
      .parse(await controlPlane.listTeams(ctx, { mine: true }))
      .map(pick)
    // 어느 팀에도 안 들어간 멤버에게는 기본 팀을 보여준다. 팀 로스터는 워크스페이스 멤버십과 별도라서 아무 팀에도
    // 없는 상태가 정상적으로 존재하고(팀 도입 마이그레이션이 만든 기본 팀은 로스터가 비어 있다), 그때 "Your teams"
    // 가 비면 이슈로 가는 입구가 사이드바에서 통째로 사라진다 — 이슈는 팀 안에 살기 때문이다. 기본 팀은 어차피
    // 팀을 지정하지 않은 이슈가 떨어지는 곳이므로, 배정 전까지의 집으로 보여주는 것이 사실과도 맞는다.
    if (teams.length === 0) {
      const all = teamsWithSummarySchema.parse(await controlPlane.listTeams(ctx)).map(pick)
      const fallback = all.find((team) => team.isDefault) ?? all[0]
      teams = fallback ? [fallback] : []
    }
  } catch {
    teams = []
  }

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
      teams={teams}
      {...(principal.email !== undefined ? { email: principal.email } : {})}
      {...(principal.profile !== undefined ? { profile: principal.profile } : {})}
    >
      {children}
    </ShellSwitch>
  )
}
