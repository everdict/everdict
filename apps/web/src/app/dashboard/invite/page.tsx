import { AcceptInviteCard } from '@/features/accept-invite'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 초대 수락 페이지 — 공유 링크 `/dashboard/invite?token=…` 진입점. 대시보드 레이아웃의 인증 게이트가 로그인 보장.
// GET 으로 자동 수락하지 않고(일회용 토큰 prefetch 소진 방지) 카드의 버튼(POST 액션)으로만 redeem.
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const token = typeof sp.token === 'string' ? sp.token : undefined

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PageHeader title="워크스페이스 초대" description="초대 링크로 워크스페이스에 참여합니다." />
      {!token ? (
        <EmptyState
          title="유효하지 않은 초대 링크입니다."
          hint="토큰이 없습니다. 초대한 사람에게 새 링크를 요청하세요."
        />
      ) : (
        <Card className="p-6">
          <AcceptInviteCard token={token} />
        </Card>
      )}
    </div>
  )
}
