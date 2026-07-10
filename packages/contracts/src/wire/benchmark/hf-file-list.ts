import { z } from "zod";

// GET /benchmarks/hf/files 200 — repo data file paths (csv/jsonl/json) for datasets the HF viewer doesn't serve.
export const HfFileListResponseSchema = z.array(z.string());
export type HfFileListResponse = z.infer<typeof HfFileListResponseSchema>;
