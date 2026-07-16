import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpstreamError } from "@everdict/contracts";
import type { BrowserSessionProvisioner, ProvisionedBrowser } from "../../common/browser-session-provisioner.js";

// Candidate Chrome/Chromium binaries, in preference order (same set the S0 live proof uses). `as const` so the
// [0] default is a non-undefined literal under noUncheckedIndexedAccess.
const CHROME_BINARIES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] as const;

// Injectable seams so the provisioner is unit-testable without a real browser.
export interface LocalChromeOptions {
  spawn?: (bin: string, args: string[]) => ChildProcess;
  fetch?: typeof fetch;
  binary?: string; // override the launched binary (tests inject a fake; prod auto-detects)
  freePort?: () => Promise<number>;
  readyTimeoutMs?: number; // wait for CDP /json/version (default 15s)
  windowSize?: string; // --window-size (default 1280,800)
}

// Ask the OS for a free TCP port by binding to 0 and reading the assigned port. Deterministic (no random).
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new UpstreamError("UPSTREAM_ERROR", undefined, "Could not allocate a local CDP port."));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

// Launches a real host Chrome and exposes its CDP over a loopback port the control plane can reach directly.
// This is the S1 self-hosted / local-reachable provisioner; managed Docker/K8s provisioners are later slices
// (docs/architecture/browser-profiles.md). Best-effort teardown kills the process and removes the user-data dir.
export class LocalChromeProvisioner implements BrowserSessionProvisioner {
  private readonly spawnImpl: (bin: string, args: string[]) => ChildProcess;
  private readonly fetchImpl: typeof fetch;
  private readonly binary?: string;
  private readonly freePort: () => Promise<number>;
  private readonly readyTimeoutMs: number;
  private readonly windowSize: string;

  constructor(opts: LocalChromeOptions = {}) {
    this.spawnImpl = opts.spawn ?? ((bin, args) => nodeSpawn(bin, args, { stdio: "ignore" }));
    this.fetchImpl = opts.fetch ?? fetch;
    this.binary = opts.binary;
    this.freePort = opts.freePort ?? getFreePort;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
    this.windowSize = opts.windowSize ?? "1280,800";
  }

  async provision(): Promise<ProvisionedBrowser> {
    const port = await this.freePort();
    const cdpBase = `http://127.0.0.1:${port}`;
    const userDataDir = mkdtempSync(join(tmpdir(), "evd-browser-session-"));
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--window-size=${this.windowSize}`,
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ];
    const proc = this.spawnImpl(this.binary ?? CHROME_BINARIES[0], args);

    const dispose = async (): Promise<void> => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // best-effort
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };

    try {
      await this.waitForCdp(cdpBase);
    } catch (err) {
      await dispose();
      throw err instanceof UpstreamError
        ? err
        : new UpstreamError("UPSTREAM_ERROR", undefined, "Browser CDP did not come up.");
    }
    return { cdpBase, dispose };
  }

  private async waitForCdp(cdpBase: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchImpl(`${cdpBase}/json/version`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new UpstreamError("UPSTREAM_ERROR", undefined, "Browser CDP did not come up within the ready timeout.");
  }
}
