import { randomUUID } from "node:crypto";
import { UpstreamError } from "@everdict/contracts";
import { type Docker, dockerCli } from "@everdict/topology";
import type {
  BrowserSessionProvisioner,
  ProvisionBrowserOptions,
  ProvisionedBrowser,
} from "../../common/browser-session-provisioner.js";

// A managed browser provisioner (browser-profiles S6) — runs a headless Chromium in a CONTAINER (the same
// chromedp/headless-shell image the topology per-case browser uses) and exposes its CDP on a published host port,
// so the control-plane host needs Docker + a pulled image but NO host Chrome install. This decouples the interactive
// session (S1) + capture (S3) from the local environment (the host-Chrome LocalChromeProvisioner). Reuses the
// topology Docker adapter; unit-testable with a fake Docker. The CDP-in-container WS-host mismatch is handled by the
// primitives' reachableWsUrl rewrite. See docs/architecture/browser-profiles.md.
export interface DockerBrowserOptions {
  docker?: Docker;
  fetch?: typeof fetch;
  image?: string; // default chromedp/headless-shell:latest (EVERDICT_BROWSER_IMAGE)
  network?: string; // docker network (default "bridge" — a standalone browser, published to the host)
  readyTimeoutMs?: number; // wait for CDP /json/version (default 20s — a container cold-start incl. image pull)
  newName?: () => string; // container-name suffix (tests inject a fixed value)
}

export class DockerBrowserProvisioner implements BrowserSessionProvisioner {
  private readonly docker: Docker;
  private readonly fetchImpl: typeof fetch;
  private readonly image: string;
  private readonly network: string;
  private readonly readyTimeoutMs: number;
  private readonly newName: () => string;

  constructor(opts: DockerBrowserOptions = {}) {
    this.docker = opts.docker ?? dockerCli();
    this.fetchImpl = opts.fetch ?? fetch;
    this.image = opts.image ?? "chromedp/headless-shell:latest";
    this.network = opts.network ?? "bridge";
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 20_000;
    this.newName = opts.newName ?? (() => randomUUID().slice(0, 8));
  }

  async provision(opts: ProvisionBrowserOptions = {}): Promise<ProvisionedBrowser> {
    const name = `evd-browser-session-${this.newName()}`;
    // headless-shell exposes CDP on 9222 itself; add only allow-origins (host mismatch tolerated) + the optional geo
    // proxy (browser-profiles S4). The port is published to an arbitrary host port, discovered via hostPort.
    const containerId = await this.docker.run({
      name,
      image: this.image,
      network: this.network,
      publish: 9222,
      args: ["--remote-allow-origins=*", ...(opts.proxyServer ? [`--proxy-server=${opts.proxyServer}`] : [])],
    });
    const dispose = async (): Promise<void> => {
      await this.docker.rm([containerId]).catch(() => undefined); // best-effort force removal
    };
    try {
      const hostPort = await this.docker.hostPort(containerId, 9222);
      const cdpBase = `http://127.0.0.1:${hostPort}`;
      await this.waitForCdp(cdpBase);
      // Ensure a page target exists (like the topology per-case browser) so the interactive session has one to drive.
      await this.fetchImpl(`${cdpBase}/json/new?about:blank`, { method: "PUT" }).catch(() => undefined);
      return { cdpBase, dispose };
    } catch (err) {
      await dispose();
      throw err instanceof UpstreamError
        ? err
        : new UpstreamError("UPSTREAM_ERROR", undefined, "Containerized browser did not come up.");
    }
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
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      undefined,
      "Containerized browser CDP did not come up within the timeout.",
    );
  }
}
