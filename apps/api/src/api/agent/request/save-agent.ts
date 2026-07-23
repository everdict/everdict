import { AgentSpecSchema } from "@everdict/contracts";

// PUT /agents/:id body — the human "save" upsert. The id comes from the path and the version is assigned server-side
// (new id → 1.0.0; a changed spec → next patch version), so neither is accepted here. Everything else is a plain
// AgentSpec (instructions + mcpServers + model + description + tags).
export const SaveAgentBodySchema = AgentSpecSchema.omit({ id: true, version: true });
