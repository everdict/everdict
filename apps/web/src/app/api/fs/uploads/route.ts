import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'

import { uploadPathFor, uploadUrlFor } from '@/features/attach-media'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { mediaKindForContentType, mediaKindForUrl } from '@/shared/lib/media'

// Uploads a pasted or dropped file to the workspace filesystem and returns the address the body will point at.
//
// It is a route rather than a server action because of the BYTES: an action's body is JSON, so a file has to be inflated into base64
// (a 5 MiB file becomes ≈7 MB, leaving no headroom under the 8 MB limit), encoding twice what the browser can already send as multipart.
// Write permission (files:write) is judged by the control plane.

// A mirror of the control plane's FS_FILE_MAX_BYTES. The web cannot pull the contracts value at runtime (runtime decoupling), so it is written
// here and an oversized file is turned back before uploading — better than sending 6 MB and receiving a 400.
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
      // It only ever writes a NEW file — the control plane is left to refuse with a 409, so a colliding identifier cannot land on top of somebody else's attachment.
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
