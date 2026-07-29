// Client-side path arithmetic for the Files workbench + shell. Paths are canonical workspace-relative
// ('' = root, 'a/b/c' nested) — the same convention the control plane normalizes to. `..` resolution here is
// pure UX (the shell's cd); the server re-normalizes and rejects traversal regardless.

// A tree entry addressed for a bulk action — the path plus what it is (a folder deletes recursively).
export type FsTarget = { path: string; kind: 'file' | 'dir' }

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

// Does `root` cover `path` — is it the entry itself or an ancestor folder of it? Deleting a folder takes its
// whole subtree with it, so hosts use this to decide whether a removal carried away the file they had open.
export function coversPath(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

// Drop paths already covered by another path in the set. A multi-select can hold both a folder and something
// inside it; deleting/moving the folder already carries the child, so acting on the child too is a guaranteed
// failure ("no such entry") — prune it before fanning out.
export function pruneRedundantPaths(paths: string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && coversPath(other, path)))
}

// Where an entry lands when it is moved into `dir` ('' = root) — the destination folder plus its base name.
export function joinFsPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

// Which of `sources` can actually move into `dir`: not the folder itself, not back into the folder it already
// sits in (a no-op), and never into its own subtree. The control plane rejects the last two as well — filtering
// here keeps the drag cursor honest and the destination list free of choices that would only produce errors.
export function movablePaths(dir: string, sources: string[]): string[] {
  return sources.filter(
    (source) => source !== dir && parentOf(source) !== dir && !dir.startsWith(`${source}/`)
  )
}
