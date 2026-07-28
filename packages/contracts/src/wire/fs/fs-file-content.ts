import { z } from "zod";
import { FsEntrySchema } from "../../records/workspace-file.js";

// GET /fs/file 200 — a workspace file's content. Text-typed files return utf8; binary (or invalid-utf8) files
// return base64 so every file round-trips losslessly through JSON.
export const FsFileEncodingSchema = z.enum(["utf8", "base64"]);
export const FsFileContentSchema = z.object({
  entry: FsEntrySchema,
  content: z.string(),
  encoding: FsFileEncodingSchema,
});
export type FsFileContent = z.infer<typeof FsFileContentSchema>;
