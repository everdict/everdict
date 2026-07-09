import { ViewRecordSchema } from "@everdict/db";
import { z } from "zod";

// GET /views response — the views visible to the caller: workspace-shared + the caller's own private ones.
export const ViewListResponseSchema = z.array(ViewRecordSchema);
