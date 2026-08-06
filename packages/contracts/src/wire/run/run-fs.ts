import { z } from "zod";

// GET /runs/:id/fs — the live repo file tree of a running case's sandbox (the run workbench's explorer).
// Served over the same one-shot exec channel as the web terminal, so it exists exactly while the container does.
export const RunFsEntrySchema = z.object({
  path: z.string().describe("repo-relative file path"),
  status: z
    .enum(["modified", "added", "deleted"])
    .optional()
    .describe("working-tree status vs HEAD — absent for an untouched file; an untracked file reads as added"),
});
export type RunFsEntry = z.infer<typeof RunFsEntrySchema>;

export const RunFsResponseSchema = z.object({
  status: z.string().describe("the run's status — clients stop polling once it is terminal"),
  found: z
    .boolean()
    .describe("false = no live container to list, or the sandbox has no git worktree (non-repo env kinds)"),
  files: z.array(RunFsEntrySchema).describe("sorted repo files (tracked + untracked; empty when found=false)"),
  truncated: z.boolean().describe("true when the listing hit the entry cap and some files were dropped"),
});
export type RunFsResponse = z.infer<typeof RunFsResponseSchema>;

// GET /runs/:id/fs/file?path=… — one file of that live repo, with its working-tree diff riding along.
export const RunFsFileResponseSchema = z.object({
  status: z.string().describe("the run's status — clients stop polling once it is terminal"),
  found: z.boolean().describe("false = no live container / not a git worktree / no such file"),
  path: z.string().describe("the requested repo-relative path"),
  size: z.number().describe("the file's byte size in the sandbox (0 when found=false)"),
  binary: z.boolean().describe("true when the bytes are not text — content is then empty by design"),
  truncated: z.boolean().describe("true when the file is larger than the read cap and content holds only the head"),
  content: z.string().describe("UTF-8 file content (empty for a binary file or when found=false)"),
  diff: z.string().describe("working-tree diff vs HEAD for this file (empty when unchanged or untracked)"),
});
export type RunFsFileResponse = z.infer<typeof RunFsFileResponseSchema>;
