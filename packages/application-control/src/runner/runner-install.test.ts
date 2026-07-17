import { describe, expect, it } from "vitest";
import { isRunnerToken, renderRunnerInstallCommand, renderRunnerInstallScript } from "./runner-install.js";

describe("isRunnerToken", () => {
  it("accepts an rnr_ base64url token and rejects anything with a shell/URL metacharacter", () => {
    expect(isRunnerToken("rnr_abc-DEF_123")).toBe(true);
    expect(isRunnerToken("ak_notarunner")).toBe(false);
    expect(isRunnerToken('rnr_"; rm -rf /')).toBe(false); // injection attempt
    expect(isRunnerToken("rnr_a b")).toBe(false);
  });
});

describe("renderRunnerInstallCommand", () => {
  it("is a curl … | sh one-liner that carries the token in the query, trimming a trailing slash", () => {
    expect(renderRunnerInstallCommand({ token: "rnr_tok", apiUrl: "https://cp.example.com/" })).toBe(
      'curl -fsSL "https://cp.example.com/install.sh?token=rnr_tok" | sh',
    );
  });
});

describe("renderRunnerInstallScript", () => {
  const script = renderRunnerInstallScript({
    token: "rnr_tok",
    apiUrl: "https://cp.example.com/",
    releaseRepo: "everdict/everdict",
  });

  it("downloads the OS/arch-matched release asset and pairs with the embedded token + api-url", () => {
    expect(script).toContain('REPO="everdict/everdict"');
    expect(script).toContain('TOKEN="rnr_tok"');
    expect(script).toContain('API_URL="https://cp.example.com"'); // trailing slash trimmed
    expect(script).toContain('asset="everdict-runner-${os_tag}-${arch_tag}"');
    expect(script).toContain("releases/latest/download");
    expect(script).toContain('--pair "$TOKEN" --api-url "$API_URL"');
  });

  it("registers a systemd service when root, else runs in the foreground so the paste still pairs", () => {
    expect(script).toContain("systemctl enable --now everdict-runner");
    expect(script).toContain('exec "$dest" --pair "$TOKEN"');
  });
});
