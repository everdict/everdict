import { getTranslations } from 'next-intl/server'

import { commentsResponseSchema } from '@/entities/comment'
import { membersSchema } from '@/entities/member'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { SectionHeader } from '@/shared/ui/section-header'

import { buildMentionables, buildThread } from '../lib/build'
import { CommentThread } from './comment-thread'

// 재사용 서버 컴포넌트 — 리소스의 댓글/멤버를 가져와 스레드로 렌더. 상세 페이지는 이 한 줄만 넣으면 된다.
// <CommentsSection workspace={ws} resourceType="harness" resourceId={id} />
export async function CommentsSection({
  workspace,
  resourceType,
  resourceId,
  title,
}: {
  workspace: string
  resourceType: string
  resourceId: string
  title?: string
}) {
  const t = await getTranslations('discuss')
  const resolvedTitle = title ?? t('title')
  const { principal, ctx } = await currentPrincipal()
  const comments = await controlPlane
    .listComments(ctx, resourceType, resourceId)
    .then((r) => commentsResponseSchema.parse(r).comments)
    .catch(() => [])
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const isAdmin = can(principal?.roles, 'settings:write') // admin 전용 액션 → admin 판정 프록시
  const canComment = can(principal?.roles, 'comments:write')

  return (
    <section className="space-y-3">
      <SectionHeader
        title={comments.length > 0 ? `${resolvedTitle} (${comments.length})` : resolvedTitle}
      />
      <CommentThread
        workspace={workspace}
        resourceType={resourceType}
        resourceId={resourceId}
        comments={buildThread(comments, members, principal?.subject, isAdmin)}
        mentionables={buildMentionables(members)}
        canComment={canComment}
      />
    </section>
  )
}
