import { AcceptInviteCard } from '@/features/accept-invite'
import { invitePreviewSchema, type InvitePreview } from '@/entities/member'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
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

  // 비소비 미리보기 — 로그인 전에도 "어느 워크스페이스인지"(이름/썸네일)를 보여준다(서버가 토큰만 검증).
  // 실패(무효/만료/취소 또는 일시 오류)면 헤더 없이 수락 카드만 — 실제 사유는 수락 액션이 전달한다.
  let preview: InvitePreview | undefined
  if (token) {
    try {
      const ctx = await authContext()
      preview = invitePreviewSchema.parse(await controlPlane.previewInvite(ctx, token))
    } catch {
      preview = undefined
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-6 py-16">
      {!token ? (
        <>
          <PageHeader
            title="워크스페이스 초대"
            description="초대 링크로 워크스페이스에 참여해요."
          />
          <EmptyState
            title="초대 링크가 올바르지 않아요."
            hint="초대한 분에게 새 링크를 받아보세요."
          />
        </>
      ) : (
        <>
          {preview ? (
            <WorkspaceInviteHeader preview={preview} />
          ) : (
            <PageHeader
              title="워크스페이스 초대"
              description="초대 링크로 워크스페이스에 참여해요."
            />
          )}
          <Card className="p-4">
            <AcceptInviteCard token={token} />
          </Card>
        </>
      )}
    </main>
  )
}

// 초대 랜딩 헤더 — 워크스페이스 썸네일(로고, 없으면 이니셜) + 이름 + 초대 역할. 어느 워크스페이스인지 한눈에.
function WorkspaceInviteHeader({ preview }: { preview: InvitePreview }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {preview.logoUrl ? (
        // 업로드 data URL/외부 URL 이라 next/image(원격 화이트리스트)가 아닌 일반 img.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.logoUrl}
          alt=""
          className="size-16 rounded-2xl border border-border object-cover shadow-raise"
        />
      ) : (
        <div className="flex size-16 items-center justify-center rounded-2xl border border-border bg-secondary text-2xl font-[560] text-muted-foreground shadow-raise">
          {preview.name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="space-y-1">
        <h1 className="text-xl font-[560] text-foreground">{preview.name}</h1>
        <p className="text-[13px] text-muted-foreground">
          이 워크스페이스에 <span className="font-[510] text-foreground">{preview.role}</span> 로
          초대받았어요.
        </p>
      </div>
    </div>
  )
}
