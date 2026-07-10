import { ViewRecordSchema } from "../../records/view.js";

// Single-view response — the @everdict/db ViewRecordSchema IS the SSOT
// (id/tenant/name/config/visibility/createdBy/createdAt/updatedAt; config is an opaque web AnalysisConfig).
export const ViewResponseSchema = ViewRecordSchema;
