import { NextResponse } from 'next/server'

import { runtimesSchema } from '@/entities/runtime'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { sortSemverDesc } from '@/shared/lib/semver'

// 런타임 단건 BFF 프록시 — infra-panel 런타임 드릴인이 사용. 목록에서 summary(버전)를 찾고 최신 버전 spec 을
// 동봉해 한 왕복으로 준다(상세 페이지와 동일한 latest 규칙). 실패는 502 봉투.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  const ctx = await authContext()
  try {
    const summary = runtimesSchema
      .parse(await controlPlane.listRuntimes(ctx))
      .find((r) => r.id === id)
    if (!summary) return NextResponse.json({ error: 'runtime not found' }, { status: 404 })
    const latest = sortSemverDesc(summary.versions)[0] ?? summary.versions[0]
    const spec = latest ? await controlPlane.getRuntime(ctx, id, latest) : undefined
    return NextResponse.json({ summary, spec })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
