import type { FsEntry as ContractFsEntry } from '@everdict/contracts'
import type {
  FsFileContent as ContractFsFileContent,
  FsRemoveResult as ContractFsRemoveResult,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Local zod-v4 mirror of the workspace-filesystem wire shapes (runtime boundary validation stays in the web;
// the exported types are drift-guarded against @everdict/contracts so a wire change fails this typecheck).

export const fsEntrySchema = z.object({
  path: z.string(), // canonical workspace-relative path ('' = root)
  name: z.string(),
  kind: z.enum(['file', 'dir']),
  size: z.number().int().nonnegative().optional(),
  contentType: z.string().optional(),
  modifiedAt: z.string().optional(),
})
export type FsEntryView = z.infer<typeof fsEntrySchema>

export const fsFileContentSchema = z.object({
  entry: fsEntrySchema,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
})
export type FsFileContentView = z.infer<typeof fsFileContentSchema>

export const fsRemoveResultSchema = z.object({ removed: z.number().int().nonnegative() })
export type FsRemoveResultView = z.infer<typeof fsRemoveResultSchema>

// Drift guards — the contract satisfies the local view (loose-consumer direction).
type AssertAssignable<A extends B, B> = A
type _EntryGuard = AssertAssignable<Pick<ContractFsEntry, keyof FsEntryView>, FsEntryView>
type _FileGuard = AssertAssignable<
  { entry: Pick<ContractFsFileContent['entry'], keyof FsEntryView> } & Pick<
    ContractFsFileContent,
    'content' | 'encoding'
  >,
  FsFileContentView
>
type _RemoveGuard = AssertAssignable<
  Pick<ContractFsRemoveResult, keyof FsRemoveResultView>,
  FsRemoveResultView
>
