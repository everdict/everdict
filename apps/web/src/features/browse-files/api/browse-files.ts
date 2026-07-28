'use server'

import { z } from 'zod'

import {
  fsEntrySchema,
  fsFileContentSchema,
  fsRemoveResultSchema,
  type FsEntryView,
  type FsFileContentView,
  type FsRemoveResultView,
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

export async function writeFileAction(input: {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
  contentType?: string
}): Promise<FsActionResult<FsEntryView>> {
  const ctx = await authContext()
  try {
    return { ok: true, data: fsEntrySchema.parse(await controlPlane.writeFsFile(ctx, input)) }
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
