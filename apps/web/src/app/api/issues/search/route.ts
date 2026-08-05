import { NextResponse } from 'next/server'

import { issuePageSchema } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 이슈 피커의 검색창이 부르는 문. 브라우저는 제어 평면을 직접 부르지 않으므로(모든 호출은 server-only)
// 타이핑에 따라오는 검색은 우리 라우트를 거친다 — @-피커가 `/api/agent/mentions/[type]` 를 쓰는 것과 같은 모양.
//
// 좁히는 일은 제어 평면이 한다(`?q=`): 창 하나를 받아 여기서 거르면 워크스페이스가 그 창보다 커지는 순간
// 조용히 못 찾기 시작한다 — "검색했는데 없다"와 "창 밖에 있다"를 사용자는 구별할 수 없다.
const LIMIT = 20

export async function GET(request: Request): Promise<Response> {
  const ctx = await authContext()
  const params = new URL(request.url).searchParams
  const query = params.get('q')?.trim() ?? ''
  // 자기 자신은 후보가 아니다(이슈가 자기를 언급하는 링크는 아무것도 뜻하지 않는다). 호출하는 화면이 안다.
  const exclude = new Set(params.getAll('exclude'))
  try {
    const page = issuePageSchema.parse(
      await controlPlane.listIssues(ctx, { ...(query ? { search: query } : {}), limit: LIMIT })
    )
    return NextResponse.json({
      items: page.items
        .filter((issue) => !exclude.has(issue.id))
        .map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
        })),
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
