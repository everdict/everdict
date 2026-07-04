import type { Comment } from '@/entities/comment'
import type { Member } from '@/entities/member'
import { fmtSubject } from '@/shared/lib/format'

import type { Mentionable, ThreadComment } from '../model/types'

// 표시명 — 프로필 이름 우선, 없으면 이메일 로컬파트(전체 이메일 노출 금지), 그래도 없으면 subject 축약.
function displayName(m: Member | undefined, subject: string): string {
  return m?.name ?? m?.email?.split('@')[0] ?? fmtSubject(subject)
}

// 워크스페이스 멤버 → @멘션 후보(표시명 + 둥근 아바타).
export function buildMentionables(members: Member[]): Mentionable[] {
  return members.map((m) => ({
    subject: m.subject,
    name: displayName(m, m.subject),
    ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
  }))
}

// 컨트롤플레인 댓글 → 표시-준비 ThreadComment(actor 해석 + 삭제 권한 계산). 어느 상세 페이지든 동일하게 조립.
export function buildThread(
  comments: Comment[],
  members: Member[],
  currentSubject: string | undefined,
  isAdmin: boolean
): ThreadComment[] {
  return comments.map((c) => {
    const m = members.find((x) => x.subject === c.author)
    return {
      id: c.id,
      ...(c.parentId ? { parentId: c.parentId } : {}),
      actor: {
        name: displayName(m, c.author),
        ...(m?.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
        known: Boolean(m),
      },
      body: c.body,
      at: c.createdAt,
      canDelete: c.author === currentSubject || isAdmin,
    }
  })
}
