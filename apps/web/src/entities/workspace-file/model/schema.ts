import type {
  FileExecutionResult as ContractFileExecutionResult,
  FsEntry as ContractFsEntry,
  FsRevision as ContractFsRevision,
} from '@everdict/contracts'
import type {
  FsFileContent as ContractFsFileContent,
  FsRemoveResult as ContractFsRemoveResult,
  FsRevisionDiff as ContractFsRevisionDiff,
  FsWriteConflict as ContractFsWriteConflict,
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
  revision: z.number().int().positive().optional(), // current published revision (single-entry reads only)
})
export type FsEntryView = z.infer<typeof fsEntrySchema>

// One published revision — the audit unit: WHO published it (a member, or an agent with the conversation it ran
// in and the member it acted for), when, and why.
export const fsActorSchema = z.object({
  kind: z.enum(['member', 'agent', 'system']),
  subject: z.string(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  conversationId: z.string().optional(),
  onBehalfOf: z.string().optional(),
})
export type FsActorView = z.infer<typeof fsActorSchema>

export const fsRevisionSchema = z.object({
  tenant: z.string(),
  path: z.string(),
  revision: z.number().int().positive(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  hash: z.string(),
  actor: fsActorSchema,
  message: z.string().optional(),
  restoredFrom: z.number().int().positive().optional(),
  createdAt: z.string(),
})
export type FsRevisionView = z.infer<typeof fsRevisionSchema>

// The 409 payload of a write that lost a race — everything the merge dialog needs in one response.
export const fsMergeConflictSchema = z.object({
  line: z.number().int().nonnegative(),
  base: z.string(),
  ours: z.string(),
  theirs: z.string(),
})

export const fsWriteConflictSchema = z.object({
  path: z.string(),
  baseRevision: z.number().int().nonnegative(),
  headRevision: z.number().int().nonnegative(),
  head: z
    .object({
      content: z.string(),
      encoding: z.enum(['utf8', 'base64']),
      revision: z.number().int().positive(),
    })
    .optional(),
  merge: z.object({ merged: z.string(), conflicts: z.array(fsMergeConflictSchema) }).optional(),
})
export type FsWriteConflictView = z.infer<typeof fsWriteConflictSchema>

// A line diff between two revisions — hunks with context, so the viewer shows the edited passages rather than
// the whole document. `truncated` = binary or too large to compare; fall back to showing the contents.
export const fsTextDiffLineSchema = z.object({
  op: z.enum(['context', 'add', 'remove']),
  text: z.string(),
  beforeLine: z.number().int().positive().optional(),
  afterLine: z.number().int().positive().optional(),
})
export type FsTextDiffLineView = z.infer<typeof fsTextDiffLineSchema>

export const fsRevisionDiffSchema = z.object({
  path: z.string(),
  from: z.number().int().positive(),
  to: z.number().int().nonnegative(),
  diff: z.object({
    hunks: z.array(
      z.object({
        beforeStart: z.number().int().nonnegative(),
        afterStart: z.number().int().nonnegative(),
        lines: z.array(fsTextDiffLineSchema),
      })
    ),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
})
export type FsRevisionDiffView = z.infer<typeof fsRevisionDiffSchema>

export const fsFileContentSchema = z.object({
  entry: fsEntrySchema,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
})
export type FsFileContentView = z.infer<typeof fsFileContentSchema>

export const fsRemoveResultSchema = z.object({ removed: z.number().int().nonnegative() })
export type FsRemoveResultView = z.infer<typeof fsRemoveResultSchema>

// One run of a file: what it printed, how it ended, and what it left behind. A non-zero exitCode is a normal
// result to render, not an error — the viewer shows it the way a terminal would.
export const fileExecutionOutputSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  skipped: z.boolean().optional(), // something was already at that path — the run never overwrites
})
export type FileExecutionOutputView = z.infer<typeof fileExecutionOutputSchema>

export const fileExecutionResultSchema = z.object({
  path: z.string(),
  image: z.string(),
  command: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  outputs: z.array(fileExecutionOutputSchema),
})
export type FileExecutionResultView = z.infer<typeof fileExecutionResultSchema>

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
type _RevisionGuard = AssertAssignable<
  Pick<ContractFsRevision, keyof FsRevisionView>,
  FsRevisionView
>
type _ConflictGuard = AssertAssignable<
  Pick<ContractFsWriteConflict, keyof FsWriteConflictView>,
  FsWriteConflictView
>
type _RevisionDiffGuard = AssertAssignable<
  Pick<ContractFsRevisionDiff, keyof FsRevisionDiffView>,
  FsRevisionDiffView
>
type _ExecutionGuard = AssertAssignable<
  Pick<ContractFileExecutionResult, keyof FileExecutionResultView>,
  FileExecutionResultView
>
