// Client-side path arithmetic for the Files workbench + shell. Paths are canonical workspace-relative
// ('' = root, 'a/b/c' nested) — the same convention the control plane normalizes to. `..` resolution here is
// pure UX (the shell's cd); the server re-normalizes and rejects traversal regardless.

export function resolveFsPath(cwd: string, arg: string): string {
  const base = arg.startsWith('/') || cwd === '' ? [] : cwd.split('/')
  const segments = [...base]
  for (const seg of arg.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      segments.pop() // clamped at root, like cd .. in /
    } else {
      segments.push(seg)
    }
  }
  return segments.join('/')
}

export function parentOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

export function baseNameOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

export function displayPath(path: string): string {
  return `/${path}`
}

export function languageFor(path: string): 'python' | 'node' {
  return path.endsWith('.py') ? 'python' : 'node'
}

export function isMarkdownPath(path: string): boolean {
  return path.endsWith('.md') || path.endsWith('.markdown')
}

// A move rewrites the moved entry's path AND every path under it (moving a directory carries its subtree).
// Returns the open selection's new path, or undefined when the move left the selection untouched.
export function rewriteMovedPath(
  selected: string | undefined,
  from: string,
  to: string
): string | undefined {
  if (selected === undefined) return undefined
  if (selected === from) return to
  if (selected.startsWith(`${from}/`)) return `${to}${selected.slice(from.length)}`
  return undefined
}
