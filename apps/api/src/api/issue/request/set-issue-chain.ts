import { z } from "zod";

// ── THE WORK CHAIN (DEFAUL-39, docs/specs/work-chain-invariants-spec.md) ─────────────────────────────
//
// One body for four moves, with the required value carried per MOVE rather than beside them. `design` is a
// union with no third arm — "accepted, and nobody said" is the state the chain exists to refuse, and an
// optional `specPath` would be exactly that state wearing a different spelling.
//
// A discriminated union rather than four optional fields, so a body that says `move:"reject"` and carries no
// reason does not parse at all. The refusal belongs to the schema, not to a check further in.
export const SetIssueChainBodySchema = z.discriminatedUnion("move", [
  z.object({
    move: z.literal("accept"),
    design: z.discriminatedUnion("kind", [
      // The spec that governs this request, by its path in the workspace filesystem. The SERVICE refuses a
      // path that does not resolve — a pointer nobody can open is the same silence a declination abolishes.
      z.object({ kind: z.literal("spec"), path: z.string().min(1).max(600) }),
      z.object({ kind: z.literal("declined"), why: z.string().min(1).max(1000) }),
    ]),
  }),
  z.object({ move: z.literal("reject"), reason: z.string().min(1).max(2000) }),
  z.object({ move: z.literal("ship") }),
  z.object({ move: z.literal("redraft") }),
]);
