import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'

import { uploadPathFor, uploadUrlFor } from '@/features/attach-media'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { mediaKindForContentType, mediaKindForUrl } from '@/shared/lib/media'

// 붙여넣거나 끌어다 놓은 파일을 워크스페이스 파일시스템에 올리고, 본문이 가리킬 주소를 돌려준다.
//
// 서버 액션이 아니라 라우트인 이유는 바이트 때문이다: 액션의 본문은 JSON 이라 파일을 base64 로 부풀려야 하고
// (5 MiB 파일이 ≈7 MB 가 되어 8 MB 한도에 남는 여유가 없다), 브라우저가 이미 multipart 로 보낼 수 있는 것을
// 두 번 인코딩하게 된다. 쓰기 권한(files:write)은 제어 평면이 판정한다.

// 제어 평면의 FS_FILE_MAX_BYTES 거울. 웹은 contracts 의 값을 실행 시점에 가져올 수 없어(런타임 분리) 여기에
// 적어 두고, 넘는 파일은 올리기 전에 돌려보낸다 — 6 MB 를 보내 놓고 400 을 받는 것보다 낫다.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

export async function POST(request: Request): Promise<Response> {
  const ctx = await authContext()

  const form = await request.formData().catch(() => undefined)
  const file = form?.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `file exceeds ${MAX_UPLOAD_BYTES} bytes`, limit: MAX_UPLOAD_BYTES },
      { status: 413 }
    )
  }

  const path = uploadPathFor(file.name, randomUUID().slice(0, 8), new Date())
  const content = Buffer.from(await file.arrayBuffer()).toString('base64')
  try {
    await controlPlane.writeFsFile(ctx, {
      path,
      content,
      encoding: 'base64',
      ...(file.type === '' ? {} : { contentType: file.type }),
      // 새 파일로만 쓴다 — 식별자가 겹쳐 남의 첨부 위에 올라타는 일이 없도록 제어 평면이 409 로 거절하게 둔다.
      baseRevision: 0,
      message: 'attached from a discussion',
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }

  return NextResponse.json({
    path,
    url: uploadUrlFor(path),
    name: file.name,
    kind: mediaKindForContentType(file.type) ?? mediaKindForUrl(file.name),
  })
}
