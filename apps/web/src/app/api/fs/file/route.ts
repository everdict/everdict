import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 파일 트리의 업로드 문 — 로컬 파일 하나를 워크스페이스 파일시스템의 지정된 경로에 새 파일로 올린다.
// 첨부 문(`/api/fs/uploads`)과 달리 목적지를 호출자가 정한다: 트리에서 고른 폴더에 원래 이름 그대로 놓인다.
//
// 서버 액션이 아니라 라우트인 이유도 첨부 쪽과 같다 — 액션의 본문은 JSON 이라 파일을 base64 로 부풀려야 하고,
// 브라우저가 이미 multipart 로 보낼 수 있는 것을 두 번 인코딩하게 된다. 쓰기 권한(files:write)은 제어 평면이
// 판정한다.

// 제어 평면의 FS_FILE_MAX_BYTES 거울. 웹은 contracts 의 값을 실행 시점에 가져올 수 없어(런타임 분리) 여기에
// 적어 두고, 넘는 파일은 올리기 전에 돌려보낸다.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()

  const form = await request.formData().catch(() => undefined)
  const file = form?.get('file')
  const pathField = form?.get('path')
  const path = typeof pathField === 'string' ? pathField.trim().replace(/^\/+/, '') : ''
  if (!(file instanceof File) || path === '') {
    return NextResponse.json({ error: 'file and path are required' }, { status: 400 })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `file exceeds ${MAX_UPLOAD_BYTES} bytes`, limit: MAX_UPLOAD_BYTES },
      { status: 413 }
    )
  }

  const content = Buffer.from(await file.arrayBuffer()).toString('base64')
  // 새 파일로만 쓴다(baseRevision 0) — 같은 경로가 이미 있으면 제어 평면이 409 로 거절하고, 트리는 그걸 이름
  // 충돌로 보여 준다. 상태를 그대로 통과시키는 이유: 409(이름 충돌)와 413(한도 초과)은 업로더가 다르게 고친다.
  const res = await controlPlane.writeFsFileChecked(ctx, {
    path,
    content,
    encoding: 'base64',
    ...(file.type === '' ? {} : { contentType: file.type }),
    baseRevision: 0,
    message: 'uploaded from the files workbench',
  })
  if (!res.ok) {
    const envelope = res.body as { message?: unknown }
    const message =
      typeof envelope.message === 'string' ? envelope.message : `upload failed (${res.status})`
    return NextResponse.json({ error: message }, { status: res.status })
  }
  return NextResponse.json(res.body)
}
