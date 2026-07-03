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
        description="웹과 동일한 기능에 더해, 이 기기를 셀프호스티드 러너로 씁니다 — 설치 후 계정 페이지에서 버튼 한 번이면 연결됩니다."
      />
      <DownloadPanel
        release={release}
        {...(env.DESKTOP_DOWNLOAD_URL ? { fallbackUrl: env.DESKTOP_DOWNLOAD_URL } : {})}
      />
    </div>
  )
}
