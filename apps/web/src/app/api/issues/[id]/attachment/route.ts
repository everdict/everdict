import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { bytesResponse } from '@/shared/lib/http-bytes'

// The BFF for the attachment images embedded in an imported GitHub issue's body and comments. The browser's <img> points at this route — a GHE
// attachment (and a private-repo one) sits behind the same auth as the repo, and an image request leaving the everdict origin carries no GitHub
// session cookie (SameSite), so it lands on a login page. The server therefore fetches it instead, with the workspace App installation token.
// Validating the url (is it that issue's GitHub host) is OWNED by the control plane — judging it a second time here would let the two diverge.
// Attachments are not only images — a screen recording in an issue body sits behind the same auth and comes the same way. So the response
// accepts Range: Safari will not play a <video> without a 206, and Chrome cannot seek beyond its buffer.
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
