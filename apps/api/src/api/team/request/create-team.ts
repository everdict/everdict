import { TeamKeySchema } from "@everdict/contracts";
import { z } from "zod";

export const CreateTeamBodySchema = z.object({
  // Accepted in any case and normalized to uppercase by the domain — `eng` and `ENG` are the same team key.
  key: TeamKeySchema.or(z.string().min(2).max(6)),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  // Promote on creation, moving the flag off the incumbent. The FIRST team of a workspace is the default
  // regardless, because an issue filed without a team needs somewhere to land.
  isDefault: z.boolean().optional(),
  // Nest this team under another. Organisational only — a sub-team owns its own issues and mints its own
  // identifiers, so nothing about an issue's address depends on where its team sits in the tree.
  parentId: z.string().min(1).max(200).optional(),
  // Private = visible to the roster (and to workspace admins) only. A visibility filter, never a second
  // authorization axis — the trust zone stays `workspace = tenant`.
  isPrivate: z.boolean().optional(),
  members: z.array(z.string().min(1).max(200)).max(200).optional(),
});

export const UpdateTeamBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  // null clears the description; absent leaves it alone. The KEY is deliberately absent — it is baked into
  // every identifier the team has minted.
  description: z.string().max(2000).nullable().optional(),
  // null detaches the team back to the top level. Re-parenting under one of its own sub-teams is refused.
  parentId: z.string().min(1).max(200).nullable().optional(),
  isPrivate: z.boolean().optional(),
  // The team's own pace (records/cycle.ts). These were editable on the record and on the settings screen long
  // before they were accepted here, so the form saved and nothing changed — a cadence the API drops is a
  // setting that does not exist. Bounds mirror the record's.
  cyclesEnabled: z.boolean().optional(),
  cycleDurationWeeks: z.number().int().min(1).max(12).optional(),
  cycleStartDay: z.number().int().min(0).max(6).optional(),
  upcomingCycleCount: z.number().int().min(0).max(6).optional(),
  // Close an iteration when its dates run out, carrying what is left forward. OFF by default: everdict's rule
  // is that a cycle nobody closed is a cycle somebody FORGOT and every list keeps showing it — a team that has
  // settled into a rhythm opts into Linear's behaviour instead.
  cycleAutoClose: z.boolean().optional(),
  // Whether incoming work queues in front of the team's workflow. Same story as the cadence above.
  triageEnabled: z.boolean().optional(),
});

export const AddTeamMemberBodySchema = z.object({
  subject: z.string().min(1).max(200),
});
