import type { SpanAttrMapping, WorkspaceSettings } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { resolveHarnessTraceMapping } from "./resolve-harness-mapping.js";

const spec: SpanAttrMapping = { model: ["spec.model"] };
const overlay: SpanAttrMapping = { model: ["overlay.model"] };

describe("resolveHarnessTraceMapping", () => {
  it("prefers the workspace overlay over the harness spec mapping", () => {
    const settings: WorkspaceSettings = { spanAttrMappingByHarness: { h1: overlay } };
    expect(resolveHarnessTraceMapping(settings, "h1", spec)).toEqual(overlay);
  });

  it("falls back to the spec mapping when no overlay exists for the harness", () => {
    const settings: WorkspaceSettings = { spanAttrMappingByHarness: { other: overlay } };
    expect(resolveHarnessTraceMapping(settings, "h1", spec)).toEqual(spec);
  });

  it("returns undefined when neither overlay nor spec provides a mapping", () => {
    expect(resolveHarnessTraceMapping(undefined, "h1")).toBeUndefined();
    expect(resolveHarnessTraceMapping({}, "h1")).toBeUndefined();
  });
});
