import { AcceptInviteCard } from '@/features/accept-invite'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 초대 수락 페이지 — 공유 링크 `/invite?token=…` 진입점(가입 전이라 워크스페이스 슬러그가 없으므로 최상위 라우트).
// GET 으로 자동 수락하지 않고(일회용 토큰 prefetch 소진 방지) 카드의 버튼(POST 액션)으로만 redeem.
// 인증은 액션(사람 계정/OIDC 전용)이 강제한다 — 수락 성공 시 그 워크스페이스(/{workspace})로 들어간다.
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const token = typeof sp.token === 'string' ? sp.token : undefined

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-6 py-16">
      <PageHeader title="워크스페이스 초대" description="초대 링크로 워크스페이스에 참여해요." />
      {!token ? (
        <EmptyState
          title="초대 링크가 올바르지 않아요."
          hint="초대한 분에게 새 링크를 받아보세요."
        />
      ) : (
        <Card className="p-4">
          <AcceptInviteCard token={token} />
        </Card>
      )}
    </main>
  )
}
