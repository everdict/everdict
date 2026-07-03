import { DownloadPanel } from '@/features/download-desktop'
import { fetchDesktopRelease } from '@/features/download-desktop/api/releases'
import { env } from '@/shared/config/env'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 데스크톱 앱 다운로드 — private 릴리즈를 웹 로그인(멤버) 뒤에서 받는 페이지(설계 D7 후속).
// 릴리즈 메타는 서버가 GitHub 에서 읽고(5분 캐시), 실제 다운로드는 /api/desktop/download 가 302 로 넘긴다.
export default async function DownloadPage() {
  const release = await fetchDesktopRelease()
  return (
    <div className="space-y-6">
      <PageHeader
        title="데스크톱 앱"
        description="웹 기능 그대로, 이 컴퓨터를 러너로도 써요. 설치하고 계정에서 한 번만 연결하면 돼요."
      />
      <DownloadPanel
        release={release}
        {...(env.DESKTOP_DOWNLOAD_URL ? { fallbackUrl: env.DESKTOP_DOWNLOAD_URL } : {})}
      />
    </div>
  )
}
