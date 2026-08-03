import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 분석 결과 아티팩트 다운로드 BFF — 스코어카드 상세의 "분석 결과 다운로드"가 여기로 온다.
// 레코드의 analysisRef 를 브라우저에 그대로 주면 안 된다: 그 URL 은 (1) 서버 내부 엔드포인트(예: http://minio:9000)라
// 외부 사용자가 해석할 수 없고 (2) presigned 라 1시간이면 만료된다. 그래서 컨트롤플레인이 오브젝트스토어에서 읽어주고
// 웹은 그것을 첨부파일로 흘려보낸다 — 브라우저가 보는 주소는 언제나 우리 앱이다.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  try {
    const bundle = await controlPlane.getScorecardAnalysis(ctx, id)
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="scorecard-${encodeURIComponent(id)}-analysis.json"`,
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
