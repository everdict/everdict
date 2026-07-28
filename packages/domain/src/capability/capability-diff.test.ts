import type { CapabilityRecord, CapabilitySpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";

import { diffCapabilitySpecs } from "./capability-diff.js";

const rec = (over: Partial<CapabilityRecord> & { spec: CapabilityRecord["spec"] }): CapabilityRecord => ({
  id: "web-search",
  tenant: "acme",
  version: "1.0.0",
  name: "web_search",
  description: "search the web",
  visibility: "workspace",
  sharedWith: [],
  tags: [],
  createdBy: "alice",
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

describe("diffCapabilitySpecs", () => {
  it("reports a changed leaf field inside the spec", () => {
    const base = rec({
      version: "1.0.0",
      spec: { type: "mcp", url: "https://a", args: [], provides: [], requiredSecrets: [], write: false },
    });
    const candidate = rec({
      version: "1.0.1",
      spec: { type: "mcp", url: "https://b", args: [], provides: [], requiredSecrets: [], write: false },
    });
    const diff = diffCapabilitySpecs(base, candidate);
    expect(diff).toMatchObject({ id: "web-search", base: "1.0.0", candidate: "1.0.1", typeChanged: false });
    expect(diff.changes).toContainEqual({
      path: "spec.url",
      before: "https://a",
      after: "https://b",
      change: "changed",
    });
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  it("reports a changed name/description outside the spec", () => {
    const spec: CapabilitySpec = { type: "skill", instructions: "same", files: [] };
    const base = rec({ name: "old", description: "first", spec });
    const candidate = rec({ version: "1.0.1", name: "new", description: "second", spec });
    const diff = diffCapabilitySpecs(base, candidate);
    expect(diff.changes.map((c) => c.path).sort()).toEqual(["description", "name"]);
  });

  it("flags typeChanged when the kind restructures (skill → code)", () => {
    const base = rec({ spec: { type: "skill", instructions: "do X", files: [] } });
    const candidate = rec({
      version: "1.0.1",
      spec: {
        type: "code",
        language: "node",
        code: "1",
        parametersSchema: {},
        isReadOnly: true,
        requiredSecrets: [],
        examples: [],
      },
    });
    const diff = diffCapabilitySpecs(base, candidate);
    expect(diff.typeChanged).toBe(true);
    expect(diff.changes.length).toBeGreaterThan(0);
  });

  it("returns no changes and an empty summary for identical content across versions", () => {
    const spec: CapabilitySpec = { type: "skill", instructions: "same", files: [] };
    const diff = diffCapabilitySpecs(rec({ version: "1.0.0", spec }), rec({ version: "2.0.0", spec }));
    expect(diff.changes).toEqual([]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0 });
  });
});
