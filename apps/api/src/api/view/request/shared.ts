import { z } from "zod";

// Saved scorecard-analysis View — a named AnalysisConfig (opaque config: the web validates its shape) + visibility (private|workspace).
export const ViewVisibilityBody = z.enum(["private", "workspace"]);
