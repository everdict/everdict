import type { SpanAttrMapping, WorkspaceSettings } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";
import { SpanAttrMappingService } from "./span-attr-mapping-service.js";

// Shallow-merge in-memory store (mirrors the jsonb top-level-key replace the service relies on).
function fakeSettings(initial: WorkspaceSettings = {}): WorkspaceSettingsStore {
  let state: WorkspaceSettings = initial;
  return {
    async get() {
      return state;
    },
    async set(_ws, patch) {
      state = { ...state, ...patch };
      return state;
    },
  };
}

const WS = "acme";
const mapping: SpanAttrMapping = { model: ["my.llm.model"], inputTokens: ["my.tokens.in"] };

describe("SpanAttrMappingService", () => {
  it("assigns a harness overlay and reads it back", async () => {
    const svc = new SpanAttrMappingService(fakeSettings());
    await svc.assign(WS, "harness-a", mapping);
    expect(await svc.get(WS, "harness-a")).toEqual(mapping);
    expect(await svc.list(WS)).toEqual({ "harness-a": mapping });
  });

  it("clears an overlay with null without disturbing other harnesses", async () => {
    const svc = new SpanAttrMappingService(fakeSettings({ spanAttrMappingByHarness: { a: mapping, b: mapping } }));
    const map = await svc.assign(WS, "a", null);
    expect(map).toEqual({ b: mapping });
    expect(await svc.get(WS, "a")).toBeUndefined();
    expect(await svc.get(WS, "b")).toEqual(mapping);
  });

  it("get() is undefined when no overlay is set (run-time resolver then uses spec / defaults)", async () => {
    const svc = new SpanAttrMappingService(fakeSettings());
    expect(await svc.get(WS, "harness-a")).toBeUndefined();
    expect(await svc.list(WS)).toEqual({});
  });
});
