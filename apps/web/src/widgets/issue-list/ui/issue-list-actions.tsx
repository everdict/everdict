import { getTranslations } from 'next-intl/server'
import { z } from 'zod'

import {
  ImportGithubIssuesButton,
  PullGithubIssuesButton,
  type SyncedRepository,
} from '@/features/import-github-issues'
import { CreateIssueButton } from '@/features/manage-issue'
import { githubAppRepoSchema } from '@/entities/github-app'
import { issuePageSchema, type IssueSummary } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Link } from '@/shared/ui/link'
import { Skeleton } from '@/shared/ui/skeleton'

// 동기화 저장소 목록을 만들기 위한 상한. 저장소 이름을 세는 게 목적이라 한 장이면 충분하다.
const MAX_SYNCED_ROSTER = 200

// 목록 헤더의 쓰기 버튼들 — 「가져오기」·「불러오기」·「이슈 만들기」.
//
// 이 셋이 자기 컴포넌트로 나와 있는 이유는 렌더가 아니라 **대기** 때문이다. 버튼 세 개를 그리자고 읽어야 하는
// 것이 GitHub App 설치 상태 + 동기화 저장소 목록(이슈 200행) + 팀 목록인데, 예전에는 그 셋이 목록과 같은
// `Promise.all` 에 묶여 있었다: 이슈 50행은 벌써 도착했는데 툴바가 못 와서 화면 전체가 서 있었다. 이제 이
// 컴포넌트는 Suspense 경계 뒤에서 스트리밍되고, 목록은 자기 데이터만 기다린다.
export async function IssueListActions({
  workspace,
  projects,
  canReadIntegrations,
}: {
  workspace: string
  projects: { id: string; name: string }[]
  // The import picker reads the workspace App's repo list (github:read, member+) — the entry point is only
  // offered to someone who can actually complete the flow.
  canReadIntegrations: boolean
}) {
  const t = await getTranslations('issuesPage')
  const ctx = await authContext()

  const [githubConnected, syncedRoster] = await Promise.all([
    // "Is GitHub connected?" is asked through the REPO list, not the installation view: the installation view is
    // App administration (settings:read, admin-only), so a member asking it got a silent false from the catch and
    // an import entry point that claimed nothing was connected. The repo list answers the same question with the
    // read the import flow itself uses (github:read) — and repos, not installations, are what can be imported from.
    controlPlane
      .getGithubAppRepos(ctx)
      .then((r) => z.array(githubAppRepoSchema).parse(r).length > 0)
      .catch(() => false),
    // 대량 불러오기는 저장소 단위라, 버튼은 새로고칠 것이 있는 저장소만 내민다. 좁히기는 SERVER 가 한다
    // (`syncPull`) — 예전에는 필터 없는 이슈 목록을 통째로 다시 읽어 여기서 걸렀고, 저장소 이름 몇 개를
    // 부르자고 전체 테이블을 한 번 더 읽는 꼴이었다.
    controlPlane
      .listIssues(ctx, {
        syncPull: true,
        limit: MAX_SYNCED_ROSTER,
      })
      .then((r) => issuePageSchema.parse(r).items)
      .catch((): IssueSummary[] => []),
  ])

  const syncedRepositories: SyncedRepository[] = []
  for (const issue of syncedRoster) {
    const github = issue.github
    if (!github || !github.pull) continue
    const existing = syncedRepositories.find(
      (r) => r.repository === github.repository && r.host === github.host
    )
    if (existing) existing.issues += 1
    else
      syncedRepositories.push({
        repository: github.repository,
        ...(github.host ? { host: github.host } : {}),
        issues: 1,
      })
  }

  // 새 이슈가 처음 앉을 팀: 팀 목록 안에서 열었으면 그 팀, 아니면 워크스페이스의 기본 팀. 지금 보고 있는
  // 목록에 나타나지 않을 곳에 이슈를 만드는 일이 없도록 한다.

  return (
    <div className="flex flex-wrap items-center gap-2">
      <PullGithubIssuesButton repositories={syncedRepositories} />
      {githubConnected ? (
        <ImportGithubIssuesButton workspace={workspace} projects={projects} />
      ) : (
        // Never a dead import button: with no reachable installation the only useful move is connecting
        // the App, so link there instead of opening a picker that has nothing to show.
        canReadIntegrations && (
          <Link
            href={`/${workspace}/settings/integrations`}
            className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('connectGithub')}
          </Link>
        )
      )}
      <CreateIssueButton
        workspace={workspace}
        projects={projects}
      />
    </div>
  )
}

// 툴바가 도착하기 전의 자리. 버튼이 늦게 튀어나와 제목 줄을 밀어내지 않도록 같은 높이를 미리 잡아 둔다.
export function IssueListActionsSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-8 w-28" />
    </div>
  )
}
