import { z } from "zod";

// POST /campaigns/:id/rounds — one hypothesis tested. The verdict is NOT accepted here: the service derives
// it from the production diff (trials significance + experiment identity), so the loop cannot write its own
// report card.
export const LogCampaignRoundBodySchema = z.object({
  hypothesis: z.string().min(1).max(2000),
  candidateVersion: z.string().min(1).max(100),
  baselineScorecardId: z.string().min(1),
  candidateScorecardId: z.string().min(1),
  // ── REQUIRED HERE, OPTIONAL AT REST ─────────────────────────────────────────────────────────────
  //
  // A knowledge layer nobody is obliged to write is a knowledge layer that stays empty, and the whole value
  // of it is that it survives the rounds that failed. So a NEW round must say what it taught; rows written
  // before this existed still decode (`CampaignRoundSchema` keeps it optional), which is the same
  // create-vs-decode split the frame already uses.
  //
  // The minimum is 10 characters rather than 1: "n/a" is the shape this field fails as, and a floor that
  // forces a clause is the cheapest thing standing between a finding and a filler.
  learned: z.string().min(10).max(4000),
});
export type LogCampaignRoundBody = z.infer<typeof LogCampaignRoundBodySchema>;
