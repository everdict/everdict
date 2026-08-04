import { INITIATIVE_RESOURCE_LIMIT, InitiativeResourceSchema } from "@everdict/contracts";
import { z } from "zod";

// Where the goal is written down, measured or argued. A LIST replaces what is there — an editor sends the
// resulting set, and a patch that merged would make removal unexpressible. Capped so a goal cannot become a
// bookmark folder.
export const InitiativeResourcesSchema = z.array(InitiativeResourceSchema).max(INITIATIVE_RESOURCE_LIMIT);
