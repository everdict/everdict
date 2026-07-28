import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { fetchDesktopRelease } from '@/features/download-desktop/api/releases'
import { CONNECT_TABS, ConnectHub, type ConnectTab } from '@/features/get-started'
import { env } from '@/shared/config/env'
import { resolveRunnerApiUrl } from '@/shared/lib/runner-api-url'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

function isConnectTab(value: string): value is ConnectTab {
  return (CONNECT_TABS as string[]).includes(value)
}

// 코딩 에이전트 연결 허브 — /connect(기본 desktop) 및 /connect/<tab>. 옵셔널 catch-all 로 한 파일에서 처리.
// 데스크탑 다운로드는 기존 DownloadPanel 재사용, Claude/Codex 는 MCP 설치 스니펫. mcpUrl 은 러너와 동일한
// 공개 컨트롤플레인 URL(resolveRunnerApiUrl) + /mcp — 러너가 dial 하는 주소와 개념 동일하다.
export default async function ConnectPage({
  params,
}: {
  params: Promise<{ workspace: string; tab?: string[] }>
}) {
  const { workspace, tab } = await params
  const seg = tab?.[0] ?? 'desktop'
  if (!isConnectTab(seg)) notFound()

  const t = await getTranslations('connectPage')
  const base = await resolveRunnerApiUrl()
  const mcpUrl = `${base}/mcp`
  const release = await fetchDesktopRelease()

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <ConnectHub
        workspace={workspace}
        activeTab={seg}
        mcpUrl={mcpUrl}
        release={release}
        {...(env.DESKTOP_DOWNLOAD_URL ? { fallbackUrl: env.DESKTOP_DOWNLOAD_URL } : {})}
      />
    </div>
  )
}
