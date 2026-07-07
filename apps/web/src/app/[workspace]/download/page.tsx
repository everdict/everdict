import { getTranslations } from 'next-intl/server'

import { DownloadPanel } from '@/features/download-desktop'
import { fetchDesktopRelease } from '@/features/download-desktop/api/releases'
import { env } from '@/shared/config/env'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Desktop app download — a page for getting private releases behind web login (members) (design D7 follow-up).
// The server reads release metadata from GitHub (5-min cache); the actual download is handed off with a 302 by /api/desktop/download.
export default async function DownloadPage() {
  const t = await getTranslations('downloadPage')
  const release = await fetchDesktopRelease()
  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <DownloadPanel
        release={release}
        {...(env.DESKTOP_DOWNLOAD_URL ? { fallbackUrl: env.DESKTOP_DOWNLOAD_URL } : {})}
      />
    </div>
  )
}
