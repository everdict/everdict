import { safeFileName } from '@/features/attach-media'
import { fsEntrySchema, type FsEntryView } from '@/entities/workspace-file'

import { joinFsPath } from '../lib/fs-path'

// The tree's upload fan-out — one multipart POST per file, kept sequential so entries land (and failures
// report) in the order they were picked. A client module rather than a server action: an action body is JSON,
// which would base64-inflate bytes the browser already knows how to send as multipart — the same reasoning as
// the attachment door (`/api/fs/uploads`); this door just lets the caller choose the destination.

// Mirror of the control plane's FS_FILE_MAX_BYTES (runtime decoupling keeps the value out of reach) — an
// oversized file is refused before any bytes leave the browser.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

// The failure is typed rather than a message: 'tooLarge' and 'exists' get their own catalog copy (the server's
// conflict message talks about revisions, which is not what a name collision looks like to an uploader);
// everything else surfaces the server's own words.
export type UploadFailure = { name: string; kind: 'tooLarge' | 'exists' | 'error'; error?: string }

export type UploadOutcome = { uploaded: FsEntryView[]; failed: UploadFailure[] }

export async function uploadFilesInto(dir: string, files: File[]): Promise<UploadOutcome> {
  const uploaded: FsEntryView[] = []
  const failed: UploadFailure[] = []
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      failed.push({ name: file.name, kind: 'tooLarge' })
      continue
    }
    try {
      const body = new FormData()
      body.append('file', file)
      // The fs path charset is strict ([A-Za-z0-9._-] segments) — fold the OS name the way attachments do,
      // or a Korean or spaced file name would be a guaranteed 400.
      body.append('path', joinFsPath(dir, safeFileName(file.name)))
      const res = await fetch('/api/fs/file', { method: 'POST', body })
      const payload: unknown = await res.json().catch(() => undefined)
      if (!res.ok) {
        const message = (payload as { error?: unknown } | undefined)?.error
        if (res.status === 409) failed.push({ name: file.name, kind: 'exists' })
        else if (res.status === 413) failed.push({ name: file.name, kind: 'tooLarge' })
        else
          failed.push({
            name: file.name,
            kind: 'error',
            error: typeof message === 'string' ? message : `HTTP ${res.status}`,
          })
        continue
      }
      uploaded.push(fsEntrySchema.parse(payload))
    } catch (e) {
      failed.push({
        name: file.name,
        kind: 'error',
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return { uploaded, failed }
}
