import { z } from "zod";

// POST /frontdoor-callback/:runId — delivery acknowledgement (the payload was handed to the rendezvous).
export const CallbackAckResponseSchema = z.object({ ok: z.literal(true) });
