import { CampaignRoundInputSchema } from "@everdict/contracts";
import type { z } from "zod";

// POST /campaigns/:id/rounds — one hypothesis tested. The verdict is NOT accepted here: the service derives
// it from the production diff (trials significance + experiment identity), so the loop cannot write its own
// report card.
//
// ── THE BOUNDS ARE THE RECORD'S, PROJECTED — NEVER RE-SPELLED HERE ──────────────────────────────────
//
// This DTO used to carry its own `min`/`max` for every field, the MCP twin carried none, and the service
// appended the round unparsed. A row is read back through `EvolutionCampaignRecordSchema`, so a round the
// MCP door accepted and this DTO would have refused made its campaign — and the workspace list — unreadable.
// `CampaignRoundInputSchema` (contracts) is the one owner of what the row can hold; the service enforces it
// on every door; this DTO and the MCP tool both project it, so the two transports cannot drift apart again.
//
// ── `learned` IS REQUIRED HERE, OPTIONAL AT REST ────────────────────────────────────────────────────
//
// A knowledge layer nobody is obliged to write is a knowledge layer that stays empty, and the whole value
// of it is that it survives the rounds that failed. So a NEW round must say what it taught; rows written
// before this existed still decode (`CampaignRoundSchema` keeps it optional), which is the same
// create-vs-decode split the frame already uses. A transport may TIGHTEN the record's bound; it may not
// loosen it.
//
// The minimum is 10 characters rather than 1: "n/a" is the shape this field fails as, and a floor that
// forces a clause is the cheapest thing standing between a finding and a filler.
export const LogCampaignRoundBodySchema = CampaignRoundInputSchema.extend({
  learned: CampaignRoundInputSchema.shape.learned.unwrap().min(10),
});
export type LogCampaignRoundBody = z.infer<typeof LogCampaignRoundBodySchema>;
