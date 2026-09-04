import { NextResponse } from 'next/server'

import { fsFileContentSchema } from '@/entities/workspace-file'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { bytesResponse } from '@/shared/lib/http-bytes'

// The BFF that serves a workspace file as raw bytes — an `<img src>`/`<video src>` embedded in a body points here.
// The control plane serves a file as JSON (content plus encoding), which a browser media tag cannot bite into directly, and an object storage
// address is internal and expires. So this route stands in between.
//
// The path arrives as SEGMENTS rather than a query string because the address has to END in the real file name for the extension-based media
// judgement and the download name to work. The segments are normalized by the control plane, which also refuses traversal.
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
    // A file of unknown type is handed to the browser to work out — guessing here would disagree with the control plane's type table.
    contentType: file.entry.contentType ?? 'application/octet-stream',
    rangeHeader: request.headers.get('range'),
    fileName: file.entry.name,
  })
}
