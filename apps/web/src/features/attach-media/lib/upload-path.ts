// Where a pasted or dropped file lives in the workspace filesystem.
//
// Why there is no separate attachment store: the workspace already has an isolated file tree (visible as-is under Settings › Files, and read by
// the agent from the same tree), and a second store just for attachments makes the same thing managed in two places.
//
// The control plane accepts only `[A-Za-z0-9._-]` in a path segment (anything else is a 400). So names are FOLDED here — a Korean name folds
// away entirely, which is why the human-readable name is carried by the alt text inserted into the body and the path keeps only the extension.
export const UPLOAD_ROOT = 'uploads'

const MAX_STEM = 60

export function safeFileName(name: string): string {
  // The name the browser gives can arrive with a path in it (a directory drop) — only the last segment is used.
  const base = name.split(/[\\/]/).at(-1) ?? ''
  const dot = base.lastIndexOf('.')
  const rawStem = dot > 0 ? base.slice(0, dot) : base
  const rawExt = dot > 0 ? base.slice(dot + 1) : ''

  const stem = rawStem
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_STEM)
  const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '')
  const safeStem = stem === '' ? 'file' : stem
  return ext === '' ? safeStem : `${safeStem}.${ext}`
}

// A monthly folder plus a short collision-avoiding identifier. Folders are split because a directory of thousands of rows cannot be swept by a
// person under Settings › Files. The time is taken as an ARGUMENT — a pure function is what keeps a test from having to shake the clock.
export function uploadPathFor(name: string, id: string, at: Date): string {
  const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
  return `${UPLOAD_ROOT}/${month}/${id}-${safeFileName(name)}`
}

// The address that points at an uploaded file from a body. It has to go through our own route because object storage addresses are internal and
// expire (the control plane serves the bytes as JSON). The path segments are appended verbatim so the address ENDS in the real file name —
// the viewer that judges media by extension and the download name both rest on that.
export function uploadUrlFor(path: string): string {
  return `/api/fs/file/${path.split('/').map(encodeURIComponent).join('/')}`
}
