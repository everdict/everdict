import { fmtSubject } from '@/shared/lib/format'

import type { Member } from '../model/schema'

// subject → 사람 식별자. 레코드에는 불투명한 Keycloak subject 만 남으므로, "누가 했는지"를 보여주는 화면은
// 전부 이 조회를 거친다. 이 모듈은 순수 함수만 담는다 — `'use client'` 인 member-directory 에 두면
// 서버 컴포넌트에서 호출할 수 없기 때문이다(클라이언트 모듈의 export 는 서버에서 참조만 가능하다).
export type MemberProfile = { name: string; avatarUrl?: string }
export type MemberDirectory = Record<string, MemberProfile>

// 서버 컴포넌트용 조립 — listMembers 결과를 그대로 디렉터리로 만든다(클라이언트는 useMemberDirectory).
export function memberDirectoryOf(members: readonly Member[]): MemberDirectory {
  const directory: MemberDirectory = {}
  for (const m of members) {
    directory[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl !== undefined ? { avatarUrl: m.avatarUrl } : {}),
    }
  }
  return directory
}

// 보여줄 이름 — 프로필 이름, 아니면 축약한 subject(디렉터리가 아직 안 왔거나 이미 나간 멤버).
export function memberNameOf(directory: MemberDirectory, subject: string): string {
  return directory[subject]?.name ?? fmtSubject(subject)
}

// API 키 주체(`key:<workspace>`)도 멤버 레코드로 들어온다 — 사람 이름이 존재하지 않는 주체라, "누가 만들었나"
// 화면이 원시 subject 를 사람 이름 자리에 세우면 id 가 노출된다. 이런 주체는 라벨("API key")로 그린다.
export function isMachineSubject(subject: string): boolean {
  return subject.startsWith('key:')
}
