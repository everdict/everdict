import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { bytesResponse } from '@/shared/lib/http-bytes'

// 가져온 GitHub 이슈 본문/코멘트에 박힌 첨부 이미지의 BFF. 브라우저의 <img> 는 이 라우트를 가리킨다 — GHE 첨부
// (그리고 비공개 리포 첨부)는 리포와 똑같은 인증 뒤에 있고, everdict 오리진에서 나가는 이미지 요청에는 GitHub
// 세션 쿠키가 실리지 않아(SameSite) 로그인 페이지로 떨어지기 때문이다. 그래서 서버가 워크스페이스 App 설치
// 토큰으로 대신 받아온다. url 의 정당성 검사(그 이슈의 GitHub 호스트인지)는 컨트롤플레인이 소유한다 —
// 여기서 한 번 더 판단하면 두 곳이 어긋날 수 있다.
// 첨부는 이미지만이 아니다 — 이슈 본문의 화면 녹화도 같은 인증 뒤에 있어 같은 길로 온다. 그래서 응답은
// Range 를 받는다: Safari 는 206 을 못 받으면 <video> 를 아예 틀지 않고, Chrome 도 버퍼 밖으로 탐색하지 못한다.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const url = new URL(request.url).searchParams.get('url')
  if (!url) return NextResponse.json({ error: 'url is required' }, { status: 400 })
  try {
    const asset = await controlPlane.getIssueAttachment(ctx, id, url)
    return bytesResponse(Buffer.from(asset.bytes), {
      contentType: asset.contentType,
      rangeHeader: request.headers.get('range'),
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
