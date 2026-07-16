import { ModelSpecSchema } from "@everdict/contracts";

// PUT /models/:id body — the human "save" upsert. The id comes from the path and the version is assigned server-side
// (new id → 1.0.0; a changed connection → next patch version), so neither is accepted here. Everything else is a plain
// ModelSpec (provider + underlying model + baseUrl + apiKeySecret NAME + params + description + tags).
export const SaveModelBodySchema = ModelSpecSchema.omit({ id: true, version: true });
