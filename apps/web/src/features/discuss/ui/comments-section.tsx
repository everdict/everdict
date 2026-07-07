import { getTranslations } from 'next-intl/server'

import { commentsResponseSchema } from '@/entities/comment'
import { membersSchema } from '@/entities/member'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { SectionHeader } from '@/shared/ui/section-header'

import { buildMentionables, buildThread } from '../lib/build'
import { CommentThread } from './comment-thread'

// Reusable server component — fetches a resource's comments/members and renders them as a thread. A detail page only needs this one line.
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
  const isAdmin = can(principal?.roles, 'settings:write') // admin-only action → proxy for the admin determination
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
