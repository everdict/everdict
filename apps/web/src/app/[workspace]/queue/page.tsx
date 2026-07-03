import { QueueBoard } from '@/widgets/queue-board'
import { membersSchema } from '@/entities/member'
import { queueSnapshotSchema, type QueueSnapshot } from '@/entities/queue'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { AutoRefresh } from '@/shared/ui/auto-refresh'
import { Callout } from '@/shared/ui/callout'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 작업 큐 — 예약 발사·스코어카드·run 워크로드가 어느 런타임에서 돌고/기다리고, 다음은 무엇인지.
export default async function QueuePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const { ctx } = await currentPrincipal()

  let snapshot: QueueSnapshot | undefined
  let error: string | undefined
  try {
    snapshot = queueSnapshotSchema.parse(await controlPlane.getQueue(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 실행자 이름(members 조인)은 부가 정보 — 실패해도 보드 자체는 보인다.
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const live = (snapshot?.totals.running ?? 0) + (snapshot?.totals.queued ?? 0) > 0

  return (
    <div className="space-y-6">
      {/* 활성 작업이 있으면 주기 재실행으로 진행률/큐를 라이브 갱신(모두 유휴면 폴링 없음). */}
      <AutoRefresh enabled={live} intervalMs={5000} />
      <PageHeader
        title="작업"
        description="런타임별로 지금 무엇이 실행 중이고, 무엇이 기다리고, 다음 예약 발사는 무엇인지 봐요."
      />
      {error || !snapshot ? (
        <Callout tone="danger">작업 큐를 불러오지 못했어요: {error}</Callout>
      ) : (
        <QueueBoard snapshot={snapshot} workspace={workspace} authors={authors} />
      )}
    </div>
  )
}
