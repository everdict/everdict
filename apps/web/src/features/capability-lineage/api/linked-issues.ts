import 'server-only'

import { issuePageSchema, type IssueSummary } from '@/entities/issue'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

// 이 능력을 참조하는 이슈들 — 제어 평면이 이미 갖고 있던 역방향 질의(`GET /issues?linkType=&linkId=`)를
// 처음으로 쓰는 곳이다. 링크는 이슈 쪽에만 저장되므로, "이 저지가 왜 있나"를 저지 화면에서 답하려면
// 이 방향으로 물어보는 수밖에 없다.
//
// 출처 스탬프(origin)가 없는 예전 자산도 이 질의로는 잡힌다 — 누군가(또는 에이전트가) 이슈에 링크를
// 걸어뒀다면. 그래서 소급 백필 없이도 기존 자산이 자기 이슈를 보여줄 수 있다.
//
// 보조 정보라서 실패해도 상세는 그대로 그린다(빈 목록).
const MAX_LINKED_ISSUES = 20

export async function loadLinkedIssues(
  ctx: AuthContext,
  linkType: 'harness' | 'dataset' | 'judge',
  linkId: string
): Promise<IssueSummary[]> {
  return controlPlane
    .listIssues(ctx, { linkType, linkId, limit: MAX_LINKED_ISSUES })
    .then((r) => issuePageSchema.parse(r).items)
    .catch((): IssueSummary[] => [])
}
