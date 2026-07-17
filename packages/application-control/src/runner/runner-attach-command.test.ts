import { describe, expect, it } from "vitest";
import { renderRunnerAttachCommand } from "./runner-attach-command.js";

describe("renderRunnerAttachCommand", () => {
  it("passes the token as a POSITIONAL --pair value (never a --token flag the CLI would drop)", () => {
    const cmd = renderRunnerAttachCommand({ token: "rnr_abc123", apiUrl: "https://cp.example.com" });
    // The CLI reads flags.get("pair"); `--pair --token <rnr_…>` would parse `pair` as the boolean "true" and lose the token.
    expect(cmd).toContain('--pair "rnr_abc123"');
    expect(cmd).not.toContain("--token");
    expect(cmd).toBe('everdict runner --pair "rnr_abc123" --api-url "https://cp.example.com"');
  });

  it("appends --api-url when present, trimming a trailing slash", () => {
    expect(renderRunnerAttachCommand({ token: "rnr_x", apiUrl: "https://cp.example.com/" })).toBe(
      'everdict runner --pair "rnr_x" --api-url "https://cp.example.com"',
    );
  });

  it("omits --api-url when no apiUrl is given", () => {
    expect(renderRunnerAttachCommand({ token: "rnr_x" })).toBe('everdict runner --pair "rnr_x"');
  });
});
