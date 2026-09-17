import { z } from "zod";
import { NodeRefSchema } from "../knowledge/node-ref.js";

// ── THE RETRIEVAL RECEIPT — what an assembly ANSWERED, written by the assembly ────────────────────────
//
// Task-context assembly is the whole of Everdict's knowledge retrieval, and until this record existed nothing
// said what it had returned. The gap is not bookkeeping: every later question about the knowledge layer —
// were the anchors enough, is an index worth building, which entries are dead weight, did the cap decide what
// a session saw — is a question about what was RETURNED, and the only party that can answer it is the one
// that answered the call (rule `protocol` L3: provenance is born at the source).
//
// The session's half — what it OPENED and whether the work used it — cannot be known here and is deliberately
// absent: a session writes that beside this file, never into it. Two authors, two files; a transcription that
// shares a path with a stamp is a transcription nobody can tell from a stamp.
export const RetrievalReceiptSchema = z.object({
  at: z.string(),
  tenant: z.string().min(1),
  // WHO asked. The subject is the credential's; `sessionId` is the SERVER'S own correlator (the MCP
  // transport's generated id), not a client-supplied label — a receipt keyed by something the caller chooses
  // could be pointed at another session's directory.
  subject: z.string().min(1),
  sessionId: z.string().min(1),
  anchors: z.array(NodeRefSchema),
  // What came back, at listing level: enough to ask later "was this the entry the work needed" without
  // re-running an assembly whose inputs have since moved.
  knowledge: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.string().min(1),
      title: z.string(),
      status: z.string().min(1),
      relation: z.string().optional(),
      coverage: z.string().optional(),
    }),
  ),
  skills: z.array(z.object({ id: z.string().min(1), name: z.string(), relation: z.string().optional() })),
  // WHAT THE CAP DECIDED. `available` is what matched before the page was taken, `returned` what survived it:
  // equal means the workspace answered, different means the CAP answered, and a receipt that reported only
  // the survivors would make those two the same reading.
  counts: z.object({
    knowledgeAvailable: z.number().int().nonnegative(),
    knowledgeReturned: z.number().int().nonnegative(),
    skillsAvailable: z.number().int().nonnegative(),
    skillsReturned: z.number().int().nonnegative(),
  }),
});
export type RetrievalReceipt = z.infer<typeof RetrievalReceiptSchema>;

// ── AND WHETHER IT LANDED ─────────────────────────────────────────────────────────────────────────────
//
// A read must not fail because its receipt could not be written — the context is the product. But a receipt
// that silently did not land is worse than none: every measurement built on this record would be computed
// over a corpus with invisible holes, and would read exactly like coverage. So the outcome rides the
// assembly's own result as a third value the caller cannot avoid seeing (rule `protocol` L2).
//
//   unconfigured  — this deployment composed no receipt writer. Honest and permanent, not an incident.
//   unattributed  — no session correlator reached the assembly (an HTTP caller, a background job). The read
//                   happened; nobody can say which session it belonged to, so nothing is filed.
//   write_failed  — the writer was there and refused. The one that IS an incident.
export const RetrievalReceiptOutcomeSchema = z.discriminatedUnion("recorded", [
  z.object({ recorded: z.literal(true), path: z.string().min(1) }),
  z.object({
    recorded: z.literal(false),
    reason: z.enum(["unconfigured", "unattributed", "write_failed"]),
    detail: z.string().optional(),
  }),
]);
export type RetrievalReceiptOutcome = z.infer<typeof RetrievalReceiptOutcomeSchema>;

// ── THE SESSION'S HALF ────────────────────────────────────────────────────────────────────────────────
//
// The assembly files what it ANSWERED; only the session knows what it then USED, and that half is the
// measurement every later question about this layer depends on. It is written through a tool rather than a
// raw file write for the reason `publish_checkpoint` is: the platform can check that a cited entry EXISTS,
// and a citation nobody resolved is the thing that makes a measurement series quietly wrong.
//
// An empty `used` is a real answer and is accepted: "the workspace had nothing for this work" is exactly what
// decides whether the layer earns its keep, and a session that skips writing it because the honest answer is
// empty removes the only evidence that would have shown it.
export const RetrievalUseSchema = z.object({
  at: z.string(),
  tenant: z.string().min(1),
  subject: z.string().min(1),
  sessionId: z.string().min(1),
  // The assembly this accounts for — the `receipt.path` that came back from the call.
  assemblyPath: z.string().min(1),
  used: z.array(z.object({ id: z.string().min(1), title: z.string() })).max(50),
  outcome: z.string().min(1).max(2000),
});
export type RetrievalUse = z.infer<typeof RetrievalUseSchema>;
