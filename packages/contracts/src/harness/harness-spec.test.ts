import { describe, expect, it } from "vitest";
import { TopologyDependencySchema, injectTemplateFields } from "./harness-spec.js";

const base = { store: "redis", role: "queue", isolateBy: "key-prefix" };

describe("TopologyDependencySchema.inject — BYO store env names validated at the boundary", () => {
  it("accepts a dependency without inject (back-compat)", () => {
    expect(TopologyDependencySchema.safeParse(base).success).toBe(true);
  });

  it("accepts an inject entry with no template (defaults to the canonical {url})", () => {
    const parsed = TopologyDependencySchema.safeParse({ ...base, inject: [{ env: "VALKEY_URL" }] });
    expect(parsed.success).toBe(true);
  });

  it("accepts a template over the store's field vocabulary", () => {
    const parsed = TopologyDependencySchema.safeParse({
      ...base,
      inject: [{ env: "VALKEY_URL", template: "valkey://{userinfo}{host}:{port}" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a template field outside the store's vocabulary — an authoring bug, not a verbatim passthrough", () => {
    const parsed = TopologyDependencySchema.safeParse({
      ...base,
      inject: [{ env: "VALKEY_URL", template: "redis://{host}:{port}/{database}" }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("{database}");
  });

  it("rejects inject on an external dependency — Everdict deploys nothing, so there are no coordinates to render", () => {
    const parsed = TopologyDependencySchema.safeParse({
      ...base,
      isolateBy: "external",
      inject: [{ env: "VALKEY_URL" }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("external");
  });

  it("rejects an empty env key", () => {
    const parsed = TopologyDependencySchema.safeParse({ ...base, inject: [{ env: "" }] });
    expect(parsed.success).toBe(false);
  });
});

describe("injectTemplateFields", () => {
  it("extracts every {field} token", () => {
    expect(injectTemplateFields("valkey://{userinfo}{host}:{port}")).toEqual(["userinfo", "host", "port"]);
  });

  it("returns nothing for a literal template", () => {
    expect(injectTemplateFields("redis://fixed:6379")).toEqual([]);
  });
});
