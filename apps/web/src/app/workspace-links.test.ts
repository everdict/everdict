import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Every in-app link into a workspace route names a page that exists.
//
// A page deleted in one change leaves links to it in others, and nothing fails: Next renders the link, the
// click lands on a 404, and no build or type check can tell. The dataset detail page kept linking a recipe
// provenance to `/<workspace>/recipes/<id>` long after the recipes pages were removed. This reads every link
// written as `/${workspace}/<segment>` and requires `src/app/[workspace]/<segment>` to be a route folder —
// the first segment only, which is where a removed page shows.

const SRC = path.resolve(__dirname, '..')
const WORKSPACE_ROUTES = path.join(SRC, 'app', '[workspace]')
const LINK = /`\/\$\{(?:workspace|ws|params\.workspace|slug)\}\/([a-z][a-z0-9-]*)/g

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

describe('workspace links', () => {
  it('name a route folder that exists under app/[workspace]', () => {
    const links: { file: string; segment: string }[] = []
    for (const file of sources(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(LINK)) {
        links.push({ file: path.relative(SRC, file), segment: m[1] ?? '' })
      }
    }
    // An empty corpus would pass while reading nothing — the pattern stopped matching how links are written.
    expect(links.length).toBeGreaterThan(50)
    const dead = links.filter(({ segment }) => !existsSync(path.join(WORKSPACE_ROUTES, segment)))
    expect(dead).toEqual([])
  })
})
