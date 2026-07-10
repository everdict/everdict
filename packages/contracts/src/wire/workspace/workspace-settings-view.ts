import { WorkspaceSettingsSchema } from "../../records/workspace-settings.js";

// Workspace settings response — the @everdict/db WorkspaceSettingsSchema IS the SSOT (jsonb policy record:
// metering, default judge, integrations, image registries, trace sinks, CI links). All secret fields are
// SecretStore name-refs — plaintext values are never stored or returned. GET returns {} when nothing is set.
export const WorkspaceSettingsViewSchema = WorkspaceSettingsSchema;
