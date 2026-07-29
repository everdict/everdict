import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// A single knowledge entry — the claim behind a `knowledge` node picked on the map. On-demand because the graph
// carries only labels: the split-view panel loads the body (and its coverage decoration) when the member opens one,
// instead of the page shipping every claim's markdown up front. Foreign private / missing → the control plane 404s.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  const ctx = await authContext()
  try {
    return NextResponse.json(await controlPlane.getKnowledgeEntry(ctx, id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
