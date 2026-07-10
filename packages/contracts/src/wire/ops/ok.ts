import { z } from "zod";

// Plain acknowledgement for internal finalize bridges (batch finalize / schedule fire finalize).
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;
