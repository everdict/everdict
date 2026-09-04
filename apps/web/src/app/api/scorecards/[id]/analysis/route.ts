import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The analysis artifact download BFF — the scorecard detail's "download analysis" comes here.
// The record's analysisRef must not be handed to the browser: that URL is (1) an internal server endpoint (http://minio:9000, say) an external
// user cannot resolve, and (2) presigned, so it expires within the hour. So the control plane reads it from object storage and the web streams
// it out as an attachment — the address the browser sees is always our own app.
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
