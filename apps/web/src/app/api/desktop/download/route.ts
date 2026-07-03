import { NextResponse } from 'next/server'

import { findDesktopAsset } from '@/features/download-desktop/api/releases'
import { currentPrincipal } from '@/shared/auth/principal'
import { env } from '@/shared/config/env'

// 데스크톱 설치파일 다운로드 프록시 — private 리포의 릴리즈 에셋을 웹 로그인(멤버) 뒤에서만 내려준다.
// GitHub asset API 에 octet-stream 으로 요청하면 서명된 임시 URL 로 302 를 주므로 그대로 리다이렉트
// (대용량이 웹 서버를 통과하지 않음). 토큰은 서버 env 에만 존재. 설계: docs/architecture/desktop-app.md.
export async function GET(request: Request): Promise<Response> {
  const { principal } = await currentPrincipal()
  if (!principal) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 })

  const idRaw = new URL(request.url).searchParams.get('id')
  const id = Number(idRaw)
  if (!idRaw || !Number.isInteger(id) || id <= 0)
    return NextResponse.json({ error: '유효한 에셋 id 가 필요합니다.' }, { status: 400 })

  const token = env.DESKTOP_RELEASES_TOKEN
  // 우리 데스크톱 릴리즈에 속한 에셋만 허용 — 임의 id 프록시 방지.
  const asset = token ? await findDesktopAsset(id) : null
  if (!asset || !token)
    return NextResponse.json(
      { error: '릴리즈를 찾을 수 없습니다(서버 릴리즈 토큰 미설정?).' },
      { status: 404 }
    )

  const gh = await fetch(
    `https://api.github.com/repos/${env.DESKTOP_RELEASES_REPO}/releases/assets/${asset.id}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/octet-stream',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'manual', // 302 의 서명 URL 을 그대로 브라우저에 넘긴다
      cache: 'no-store',
    }
  )
  const location = gh.headers.get('location')
  if (gh.status >= 300 && gh.status < 400 && location) return NextResponse.redirect(location, 302)
  // 일부 환경(GHE 등)은 리다이렉트 없이 본문을 준다 — 그대로 스트리밍.
  if (gh.ok && gh.body)
    return new Response(gh.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${asset.name}"`,
      },
    })
  return NextResponse.json({ error: `다운로드 실패 (GitHub ${gh.status})` }, { status: 502 })
}
