// 댓글 스레드 표시 모델 — 서버(페이지)가 조립해 클라이언트 컴포넌트로 넘긴다(actor 해석/권한 계산 완료).
export interface Mentionable {
  subject: string
  name: string
  avatarUrl?: string
}

export interface ThreadComment {
  id: string
  parentId?: string
  actor: { name: string; avatarUrl?: string; known: boolean }
  body: string
  at: string
  canDelete: boolean
}
