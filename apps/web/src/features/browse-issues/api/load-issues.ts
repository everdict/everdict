'use server'

import { issuePageSchema, type IssuePage } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import type { IssuePageQuery } from '../model/page-query'

// 한 그룹의 다음 장. 묶인 화면은 그룹마다 자기 장을 들고 있으므로 「더 보기」도 그룹마다 따로다 — 전체를
// 다시 그리는 대신 그 그룹에만 행을 이어 붙인다(리니어의 그룹 안 더 보기와 같은 동선).
//
// 실패는 던지지 않고 돌려준다: 목록 한 귀퉁이의 버튼이 페이지 전체를 에러 경계로 날리면 안 되고, 사유는
// 그 자리에서 읽혀야 한다.
export async function loadIssuePageAction(
  query: IssuePageQuery
): Promise<{ ok: true; page: IssuePage } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    return { ok: true, page: issuePageSchema.parse(await controlPlane.listIssues(ctx, query)) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
