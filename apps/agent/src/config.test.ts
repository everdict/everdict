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
      AGENT_ALLOW_EVAL_DRIVE: "", // z.enum(["true","false"]) rejects "" if not stripped
    });
    expect(config.AGENT_MODEL).toBeUndefined();
    expect(config.AGENT_TOOL_TIMEOUT_MS).toBeUndefined();
    expect(config.AGENT_THINKING_BUDGET).toBeUndefined();
    expect(config.AGENT_MAX_TURNS).toBeUndefined();
    expect(config.AGENT_ALLOW_EVAL_DRIVE).toBe(false);
  });

  it("still parses configured optional values", () => {
    const config = loadConfig({
      ...BASE,
      AGENT_MODEL: "claude-opus-4-8",
      AGENT_TOOL_TIMEOUT_MS: "120000",
      AGENT_ALLOW_EVAL_DRIVE: "true",
    });
    expect(config.AGENT_MODEL).toBe("claude-opus-4-8");
    expect(config.AGENT_TOOL_TIMEOUT_MS).toBe(120000);
    expect(config.AGENT_ALLOW_EVAL_DRIVE).toBe(true);
  });
});
