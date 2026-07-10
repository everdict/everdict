import { z } from "zod";
import { ViewRecordSchema } from "../../records/view.js";

// GET /views response — the views visible to the caller: workspace-shared + the caller's own private ones.
export const ViewListResponseSchema = z.array(ViewRecordSchema);
