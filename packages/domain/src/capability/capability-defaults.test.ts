import { describe, expect, it } from "vitest";
import { type DefaultCapabilityInput, selectDefaultCapabilities } from "./capability-defaults.js";

const webSearch: DefaultCapabilityInput = { id: "web-search", name: "web_search", requires: null };
const pdf: DefaultCapabilityInput = { id: "pdf-read", name: "pdf_read", requires: null };
const mattermost: DefaultCapabilityInput = { id: "mm-post", name: "mattermost_post", requires: "mattermost" };
const github: DefaultCapabilityInput = { id: "gh-issue", name: "github_create_issue", requires: "github" };

const base = { integrationsConfigured: [], disabledDefaults: [], takenNames: [] } as const;

describe("selectDefaultCapabilities", () => {
  it("includes unconditional (requires:null) defaults regardless of configured integrations", () => {
    const selected = selectDefaultCapabilities([webSearch, pdf], base);
    expect(selected.map((d) => d.id)).toEqual(["web-search", "pdf-read"]);
  });

  it("gates an integration default on that integration being configured", () => {
    expect(selectDefaultCapabilities([mattermost, github], base)).toEqual([]);
    const selected = selectDefaultCapabilities([mattermost, github], { ...base, integrationsConfigured: ["github"] });
    expect(selected.map((d) => d.id)).toEqual(["gh-issue"]);
  });

  it("excludes a default the workspace opted out of (by id)", () => {
    const selected = selectDefaultCapabilities([webSearch, pdf], { ...base, disabledDefaults: ["pdf-read"] });
    expect(selected.map((d) => d.id)).toEqual(["web-search"]);
  });

  it("shadows a default whose tool name is already taken by an adopted/authored tool", () => {
    const selected = selectDefaultCapabilities([webSearch, pdf], { ...base, takenNames: ["web_search"] });
    expect(selected.map((d) => d.id)).toEqual(["pdf-read"]);
  });

  it("preserves input order deterministically", () => {
    const selected = selectDefaultCapabilities([pdf, webSearch, github], {
      ...base,
      integrationsConfigured: ["github"],
    });
    expect(selected.map((d) => d.id)).toEqual(["pdf-read", "web-search", "gh-issue"]);
  });
});
