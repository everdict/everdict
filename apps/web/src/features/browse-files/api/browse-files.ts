'use server'

import { z } from 'zod'

import {
  fileExecutionResultSchema,
  fsEntrySchema,
  fsFileContentSchema,
  fsRemoveResultSchema,
  fsRevisionDiffSchema,
  fsRevisionSchema,
  fsWriteConflictSchema,
  type FileExecutionResultView,
  type FsEntryView,
  type FsFileContentView,
  type FsRemoveResultView,
  type FsRevisionDiffView,
  type FsRevisionView,
  type FsWriteConflictView,
} from '@/entities/workspace-file'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Server actions for the interactive Files workbench (tree + viewer + shell). They RETURN data instead of
// revalidating the route — the workbench owns its client-side cache and a full RSC refresh would reset the
// explorer/shell state mid-interaction. Enforcement (files:read / files:write) is the control plane's.

export interface FsActionResult<T> {
  ok: boolean
  data?: T
  error?: string
  // A write that lost a race carries the resolution kit instead of a bare message: what is live now and the
  // attempted three-way merge. Present only on writeFileAction, and only when a baseRevision was declared.
  conflict?: FsWriteConflictView
}

function fail<T>(e: unknown): FsActionResult<T> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) }
}

export async function listFilesAction(path: string): Promise<FsActionResult<FsEntryView[]>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: z.array(fsEntrySchema).parse(await controlPlane.listFsEntries(ctx, path)),
    }
  } catch (e) {
    return fail(e)
  }
}

export async function readFileAction(path: string): Promise<FsActionResult<FsFileContentView>> {
  const ctx = await authContext()
  try {
    return { ok: true, data: fsFileContentSchema.parse(await controlPlane.readFsFile(ctx, path)) }
  } catch (e) {
    return fail(e)
  }
}

// Publish a revision. Pass `baseRevision` (the revision the editor loaded) whenever editing an EXISTING file:
// members and agents write these files concurrently, and without it a save silently overwrites whatever was
// published meanwhile. A refused write comes back with `conflict` — the live content plus the attempted merge —
// so the caller can offer a resolution rather than an error message.
export async function writeFileAction(input: {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
  contentType?: string
  baseRevision?: number
  message?: string
}): Promise<FsActionResult<FsEntryView>> {
  const ctx = await authContext()
  try {
    const res = await controlPlane.writeFsFileChecked(ctx, input)
    if (res.ok) return { ok: true, data: fsEntrySchema.parse(res.body) }
    const envelope = res.body as { message?: unknown; data?: unknown }
    const message =
      typeof envelope.message === 'string' ? envelope.message : `write failed (${res.status})`
    if (res.status !== 409) return { ok: false, error: message }
    const conflict = fsWriteConflictSchema.safeParse(envelope.data)
    return conflict.success
      ? { ok: false, error: message, conflict: conflict.data }
      : { ok: false, error: message }
  } catch (e) {
    return fail(e)
  }
}

// Run the open file in a sandbox. The whole run happens inside this call (there is no execution record to poll),
// so a long script holds the action open until its in-sandbox timeout — which is why that timeout is capped.
export async function runFileAction(
  path: string,
  image?: string
): Promise<FsActionResult<FileExecutionResultView>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: fileExecutionResultSchema.parse(
        await controlPlane.runFsFile(ctx, { path, ...(image !== undefined ? { image } : {}) })
      ),
    }
  } catch (e) {
    return fail(e)
  }
}

// `before` walks further back: the oldest revision already on screen is the cursor, so a file with a thousand
// revisions stays browsable instead of stopping at the first page.
export async function listRevisionsAction(
  path: string,
  opts?: { limit?: number; before?: number }
): Promise<FsActionResult<FsRevisionView[]>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: z
        .array(fsRevisionSchema)
        .parse(await controlPlane.listFsRevisions(ctx, path, opts?.limit, opts?.before)),
    }
  } catch (e) {
    return fail(e)
  }
}

// What changed between a past revision and another one (default: the live file).
export async function diffRevisionsAction(
  path: string,
  from: number,
  to?: number
): Promise<FsActionResult<FsRevisionDiffView>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: fsRevisionDiffSchema.parse(await controlPlane.diffFsRevisions(ctx, path, from, to)),
    }
  } catch (e) {
    return fail(e)
  }
}

export async function readRevisionAction(
  path: string,
  revision: number
): Promise<FsActionResult<FsFileContentView>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: fsFileContentSchema.parse(await controlPlane.readFsRevision(ctx, path, revision)),
    }
  } catch (e) {
    return fail(e)
  }
}

export async function restoreRevisionAction(
  path: string,
  revision: number
): Promise<FsActionResult<FsEntryView>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: fsEntrySchema.parse(await controlPlane.restoreFsRevision(ctx, { path, revision })),
    }
  } catch (e) {
    return fail(e)
  }
}

export async function makeDirectoryAction(path: string): Promise<FsActionResult<FsEntryView>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: fsEntrySchema.parse(await controlPlane.makeFsDirectory(ctx, { path })),
    }
  } catch (e) {
    return fail(e)
  }
}

export async function moveEntryAction(
  from: string,
  to: string
): Promise<FsActionResult<FsEntryView>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: fsEntrySchema.parse(await controlPlane.moveFsEntry(ctx, { from, to })),
    }
  } catch (e) {
    return fail(e)
  }
}

export async function removeEntryAction(
  path: string,
  recursive: boolean
): Promise<FsActionResult<FsRemoveResultView>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: fsRemoveResultSchema.parse(await controlPlane.removeFsEntry(ctx, path, recursive)),
    }
  } catch (e) {
    return fail(e)
  }
}

// Bulk delete / move for the tree's multi-select. The control plane exposes single-entry operations only, so the
// fan-out happens here — one round trip for the whole selection instead of one per entry, each authorized
// server-side. A failure on one entry (gone / permission / name taken at the destination) is reported per path
// rather than aborting the set, so the tree can drop what succeeded and leave the rest actionable for retry.

export async function removeEntriesAction(
  targets: { path: string; recursive: boolean }[]
): Promise<{ removed: string[]; failed: { path: string; error: string }[] }> {
  const ctx = await authContext()
  const removed: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const target of targets) {
    try {
      fsRemoveResultSchema.parse(
        await controlPlane.removeFsEntry(ctx, target.path, target.recursive)
      )
      removed.push(target.path)
    } catch (e) {
      failed.push({ path: target.path, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { removed, failed }
}

export async function moveEntriesAction(
  moves: { from: string; to: string }[]
): Promise<{ moved: { from: string; to: string }[]; failed: { path: string; error: string }[] }> {
  const ctx = await authContext()
  const moved: { from: string; to: string }[] = []
  const failed: { path: string; error: string }[] = []
  for (const move of moves) {
    try {
      fsEntrySchema.parse(await controlPlane.moveFsEntry(ctx, move))
      moved.push(move)
    } catch (e) {
      failed.push({ path: move.from, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { moved, failed }
}
