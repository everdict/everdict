import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// 데스크탑 다운로드는 연결 허브의 한 탭으로 통합됨(/connect/desktop). 북마크·기존 딥링크 보존을 위해 리다이렉트만 남긴다.
export default async function DownloadPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  redirect(`/${workspace}/connect/desktop`)
}
