import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Live-log snapshot BFF proxy — the run detail's LiveLogs widget polls it (the client never hits the control
// plane directly). Workspace scoping/authz is enforced by the control plane; this is a pure token courier.
// ?stream=stderr tails the job's stderr (harness progress); default stdout (the result stream).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const raw = new URL(request.url).searchParams.get('stream')
  const stream = raw === 'stderr' ? 'stderr' : undefined // anything else = the control-plane default (stdout)
  try {
    return NextResponse.json(await controlPlane.getRunLogs(ctx, id, stream))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
