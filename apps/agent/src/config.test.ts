import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BASE = { CONTROL_PLANE_URL: "http://api:8787" } as const;

describe("loadConfig", () => {
  it("derives the MCP endpoint from the control plane URL by default", () => {
    const config = loadConfig({ ...BASE });
    expect(config.mcpUrl).toBe("http://api:8787/mcp");
    expect(config.PORT).toBe(8790);
  });

  it("treats empty-string optional env values as unset (compose pass-through does not crash boot)", () => {
    // How docker-compose `${VAR:-}` forwards every unconfigured optional var — a bare "".
    const config = loadConfig({
      ...BASE,
      AGENT_MODEL: "",
      AGENT_LLM_API_KEY: "",
      AGENT_TOOL_TIMEOUT_MS: "", // z.coerce.number() on "" → 0 → .positive() would throw if not stripped
      AGENT_THINKING_BUDGET: "",
      AGENT_MAX_TURNS: "",
    });
    expect(config.AGENT_MODEL).toBeUndefined();
    expect(config.AGENT_TOOL_TIMEOUT_MS).toBeUndefined();
    expect(config.AGENT_THINKING_BUDGET).toBeUndefined();
    expect(config.AGENT_MAX_TURNS).toBeUndefined();
  });

  it("leaves the web base unset when the deployment did not configure one (no localhost guess)", () => {
    // Given a deployment whose compose forwards an unconfigured WEB_BASE_URL as "" — a localhost default here
    // would put a link the member cannot open into every self-hosted conversation.
    const config = loadConfig({ ...BASE, WEB_BASE_URL: "" });
    expect(config.WEB_BASE_URL).toBeUndefined();
    expect(loadConfig({ ...BASE }).WEB_BASE_URL).toBeUndefined();
  });

  it("carries the deployment's own web base when configured", () => {
    const config = loadConfig({ ...BASE, WEB_BASE_URL: "https://everdict.acme.internal" });
    expect(config.WEB_BASE_URL).toBe("https://everdict.acme.internal");
  });

  it("still parses configured optional values", () => {
    const config = loadConfig({
      ...BASE,
      AGENT_MODEL: "claude-opus-4-8",
      AGENT_TOOL_TIMEOUT_MS: "120000",
    });
    expect(config.AGENT_MODEL).toBe("claude-opus-4-8");
    expect(config.AGENT_TOOL_TIMEOUT_MS).toBe(120000);
  });

  it("parses the session running-memory trigger (and treats compose's empty string as unset)", () => {
    expect(loadConfig({ ...BASE, AGENT_MEMORY_TRIGGER_CHARS: "250000" }).AGENT_MEMORY_TRIGGER_CHARS).toBe(250_000);
    expect(loadConfig({ ...BASE, AGENT_MEMORY_TRIGGER_CHARS: "" }).AGENT_MEMORY_TRIGGER_CHARS).toBeUndefined();
    expect(loadConfig({ ...BASE }).AGENT_MEMORY_TRIGGER_CHARS).toBeUndefined();
  });
});
