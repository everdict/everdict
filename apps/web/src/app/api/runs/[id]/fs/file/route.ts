import { NextResponse } from 'next/server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 런 워크벤치 BFF 프록시 — 라이브 리포의 파일 1개(내용 + 워킹트리 diff).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await authContext()
  const { id } = await params
  const path = new URL(request.url).searchParams.get('path')
  if (!path) {
    return NextResponse.json({ error: 'path query parameter is required' }, { status: 400 })
  }
  try {
    return NextResponse.json(await controlPlane.getRunFsFile(ctx, id, path))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
