import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The file tree's upload door — it puts one local file into the workspace filesystem at a given path, as a NEW file.
// Unlike the attachment door (`/api/fs/uploads`), the CALLER decides the destination: it lands in the folder picked in the tree under its original name.
//
// It is a route rather than a server action for the same reason as the attachment side — an action's body is JSON, so a file has to be inflated
// into base64, encoding twice what the browser can already send as multipart. Write permission (files:write) is judged by the control plane.

// A mirror of the control plane's FS_FILE_MAX_BYTES. The web cannot pull the contracts value at runtime (runtime decoupling), so it is written
// here and an oversized file is turned back before it is uploaded.
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
  // It only ever writes a NEW file (baseRevision 0) — an existing path is refused by the control plane with a 409, which the tree shows as a name
  // collision. The status is passed through as-is because an uploader fixes a 409 (a name collision) differently from a 413 (over the limit).
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
