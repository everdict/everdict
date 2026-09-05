import type { MarkdownImageProxy } from '@/shared/ui/markdown'

// An imported issue's body and comments are the markdown the remote wrote — the images in them are GitHub addresses, and those sit behind the
// same auth as the repo. On GHE that is everything (nothing is served without a login); on github.com it is private repos. The browser viewing
// this screen has no GitHub session (a cross-site img request carries no cookies), so the server fetches them instead, through our own route.
//
// The origin list looks at the same thing the control plane's allow rule does: for a GHE copy, that one host; for a github.com copy,
// github.com plus the user-content hosts that actually appear in the body. An address not sent to the proxy here is refused over there too,
// so a divergence between the two lists produces a 400 rather than an image.
const GITHUB_COM_ORIGINS = [
  'https://github.com',
  'https://private-user-images.githubusercontent.com',
  'https://user-images.githubusercontent.com',
  'https://raw.githubusercontent.com',
  'https://objects.githubusercontent.com',
]

// An issue that was not imported (written locally) has nothing to proxy — given undefined, Markdown draws the originals as they are.
export function issueAttachmentProxy(
  issueId: string,
  github?: { host?: string }
): MarkdownImageProxy | undefined {
  if (!github) return undefined
  const origins = github.host ? originOf(github.host) : GITHUB_COM_ORIGINS
  if (origins.length === 0) return undefined
  return { origins, path: `/api/issues/${encodeURIComponent(issueId)}/attachment` }
}

// A stored host is a base URL such as "https://ghe.acme.io". It has to be normalized with new URL(...).origin to match a body image's origin as
// a STRING (lower-casing the host, omitting the default port, dropping a trailing slash).
function originOf(host: string): string[] {
  const trimmed = host.replace(/\/+$/, '')
  try {
    return [new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).origin]
  } catch {
    return []
  }
}
