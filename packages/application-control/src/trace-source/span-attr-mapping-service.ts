import type { SpanAttrMapping } from "@everdict/contracts";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Per-harness span-attribute mapping overlay (WorkspaceSettings.spanAttrMappingByHarness) — the mutable conversion
// layer between a harness version and a judge version, authored in the judge wizard against a real trace. Same
// name-keyed / whole-map-replace semantics as traceSourceByHarness (jsonb-merge replaces the top-level key). The HTTP
// route and MCP tool share this core. Resolution (overlay > spec) at run time lives in resolveHarnessTraceMapping.
export class SpanAttrMappingService {
  constructor(private readonly settings: WorkspaceSettingsStore) {}

  // The whole overlay map (harness id → mapping).
  async list(workspace: string): Promise<Record<string, SpanAttrMapping>> {
    return (await this.settings.get(workspace))?.spanAttrMappingByHarness ?? {};
  }

  // One harness's overlay (undefined = none set — the run-time resolver then uses the harness spec's mapping / defaults).
  async get(workspace: string, harnessId: string): Promise<SpanAttrMapping | undefined> {
    return (await this.settings.get(workspace))?.spanAttrMappingByHarness?.[harnessId];
  }

  // Set/clear a harness's overlay (mapping=null clears it). Returns the whole updated map.
  async assign(
    workspace: string,
    harnessId: string,
    mapping: SpanAttrMapping | null,
  ): Promise<Record<string, SpanAttrMapping>> {
    const map = { ...((await this.settings.get(workspace))?.spanAttrMappingByHarness ?? {}) };
    if (mapping === null) delete map[harnessId];
    else map[harnessId] = mapping;
    await this.settings.set(workspace, { spanAttrMappingByHarness: map });
    return map;
  }
}
