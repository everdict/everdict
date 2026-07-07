import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'

import { findDesktopAsset } from '@/features/download-desktop/api/releases'
import { currentPrincipal } from '@/shared/auth/principal'
import { env } from '@/shared/config/env'

// Desktop installer download proxy — serves release assets behind web login (members).
// The everdict/everdict repo is public, so assets read unauthenticated; a token is attached only for a private releases repo.
// Requesting the GitHub asset API as octet-stream returns a 302 to a signed temporary URL, so just redirect it through
// (large files don't pass through the web server). Any token stays in the server env. Design: docs/architecture/desktop-app.md.
export async function GET(request: Request): Promise<Response> {
  const t = await getTranslations('downloadPage')
  const { principal } = await currentPrincipal()
  if (!principal) return NextResponse.json({ error: t('errorLoginRequired') }, { status: 401 })

  const idRaw = new URL(request.url).searchParams.get('id')
  const id = Number(idRaw)
  if (!idRaw || !Number.isInteger(id) || id <= 0)
    return NextResponse.json({ error: t('errorInvalidAsset') }, { status: 400 })

  const token = env.DESKTOP_RELEASES_TOKEN // optional — only a private releases repo needs it
  // Allow only assets belonging to our desktop releases — prevent proxying an arbitrary id.
  const asset = await findDesktopAsset(id)
  if (!asset) return NextResponse.json({ error: t('errorReleaseNotFound') }, { status: 404 })

  const gh = await fetch(
    `https://api.github.com/repos/${env.DESKTOP_RELEASES_REPO}/releases/assets/${asset.id}`,
    {
      headers: {
        accept: 'application/octet-stream',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'manual', // pass the 302's signed URL straight to the browser
      cache: 'no-store',
    }
  )
  const location = gh.headers.get('location')
  if (gh.status >= 300 && gh.status < 400 && location) return NextResponse.redirect(location, 302)
  // Some environments (GHE, etc.) return the body without a redirect — stream it through as-is.
  if (gh.ok && gh.body)
    return new Response(gh.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${asset.name}"`,
      },
    })
  return NextResponse.json(
    { error: t('errorDownloadFailed', { status: gh.status }) },
    { status: 502 }
  )
}
