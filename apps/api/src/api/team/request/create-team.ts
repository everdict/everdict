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
  members: z.array(z.string().min(1).max(200)).max(200).optional(),
});

export const UpdateTeamBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  // null clears the description; absent leaves it alone. The KEY is deliberately absent — it is baked into
  // every identifier the team has minted.
  description: z.string().max(2000).nullable().optional(),
});

export const AddTeamMemberBodySchema = z.object({
  subject: z.string().min(1).max(200),
});
