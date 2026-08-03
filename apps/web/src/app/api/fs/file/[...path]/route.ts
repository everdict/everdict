import { NextResponse } from 'next/server'

import { fsFileContentSchema } from '@/entities/workspace-file'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { bytesResponse } from '@/shared/lib/http-bytes'

// 워크스페이스 파일을 바이트 그대로 내주는 BFF — 본문에 박힌 `<img src>`/`<video src>` 가 여기를 가리킨다.
// 제어 평면은 파일을 JSON(내용 + 인코딩)으로 주므로 브라우저의 미디어 태그가 직접 물 수 없고, 오브젝트 스토리지
// 주소는 서버 내부용에 만료된다. 그래서 이 라우트가 사이에 선다.
//
// 경로를 질의문자열이 아니라 세그먼트로 받는 이유: 주소가 실제 파일 이름으로 끝나야 확장자로 매체를 판정하는
// 뷰어와 다운로드 이름이 성립한다. 조각은 제어 평면이 정규화하고 traversal 을 거절한다.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const ctx = await authContext()
  const { path: segments } = await params
  const path = (segments ?? []).map((s) => decodeURIComponent(s)).join('/')
  if (path === '') return NextResponse.json({ error: 'path is required' }, { status: 400 })

  const res = await controlPlane.readFsFileChecked(ctx, path)
  if (!res.ok) {
    const envelope = res.body as { message?: unknown }
    const message =
      typeof envelope.message === 'string' ? envelope.message : `read failed (${res.status})`
    return NextResponse.json({ error: message }, { status: res.status })
  }
  const file = fsFileContentSchema.parse(res.body)
  const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
  return bytesResponse(bytes, {
    // 타입을 모르는 파일은 브라우저가 알아서 하도록 넘긴다 — 여기서 추측하면 제어 평면의 타입 표와 어긋난다.
    contentType: file.entry.contentType ?? 'application/octet-stream',
    rangeHeader: request.headers.get('range'),
    fileName: file.entry.name,
  })
}
