'use server'

import { authContext } from '@/shared/auth/principal'

import { loadIssueViewData, type IssueViewData, type IssueViewRequest } from './issue-view-data'

// 보기를 바꿨을 때 화면이 새로 받아 오는 것 — **목록뿐**이다. 라우트를 다시 그리지 않으므로 헤더·툴바·
// 디렉터리(멤버·프로젝트·라벨)는 그 자리에 그대로 있고, 그것들을 읽는 왕복도 다시 일어나지 않는다.
//
// 클라이언트가 좁히기를 조립해 보내도 되는 이유는 「더 보기」와 같다: 인가는 여전히 제어 평면이 한다.
// 이 요청은 로그인한 사람의 토큰으로 나가고, 워크스페이스·팀 가시성은 서버가 다시 건다.
//
// 실패는 던지지 않고 값으로 돌려준다 — 목록 한 귀퉁이의 조작이 페이지 전체를 에러 경계로 날리면 안 된다.
export async function loadIssueViewAction(request: IssueViewRequest): Promise<IssueViewData> {
  const ctx = await authContext()
  try {
    return await loadIssueViewData(ctx, request)
  } catch (e) {
    return {
      groups: [],
      droppedGroups: 0,
      error: { kind: 'load', message: e instanceof Error ? e.message : String(e) },
    }
  }
}
