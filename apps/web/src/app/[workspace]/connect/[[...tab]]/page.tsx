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

// The coding agent connection hub — /connect (defaulting to desktop) and /connect/<tab>. Handled in one file with an optional catch-all.
// The desktop download reuses the existing DownloadPanel; Claude and Codex are MCP installation snippets. The mcpUrl is the same public
// control plane URL the runner uses (resolveRunnerApiUrl) plus /mcp — conceptually the same address the runner dials.
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
