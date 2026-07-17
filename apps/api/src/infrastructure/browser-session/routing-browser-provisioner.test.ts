import { describe, expect, it } from "vitest";
import type {
  BrowserSessionProvisioner,
  ProvisionBrowserOptions,
  ProvisionedBrowser,
} from "../../common/browser-session-provisioner.js";
import { RoutingBrowserProvisioner } from "./routing-browser-provisioner.js";

// A provisioner that records the options it was called with and returns a labelled cdp base.
function recorder(label: string) {
  const calls: (ProvisionBrowserOptions | undefined)[] = [];
  const provisioner: BrowserSessionProvisioner = {
    async provision(opts): Promise<ProvisionedBrowser> {
      calls.push(opts);
      return { cdpBase: `http://${label}`, dispose: async () => {} };
    },
  };
  return { provisioner, calls };
}

describe("RoutingBrowserProvisioner", () => {
  it("routes to the host provisioner when no runtime is selected", async () => {
    const host = recorder("host");
    const runtime = recorder("runtime");
    const r = new RoutingBrowserProvisioner(host.provisioner, runtime.provisioner);
    const b = await r.provision({ tenant: "acme", sessionId: "bs-1" });
    expect(b.cdpBase).toBe("http://host");
    expect(host.calls).toHaveLength(1);
    expect(runtime.calls).toHaveLength(0);
  });

  it("routes to the runtime provisioner when a runtime is selected, forwarding the options", async () => {
    const host = recorder("host");
    const runtime = recorder("runtime");
    const r = new RoutingBrowserProvisioner(host.provisioner, runtime.provisioner);
    const b = await r.provision({ tenant: "acme", runtime: "nomad-eu", sessionId: "bs-1" });
    expect(b.cdpBase).toBe("http://runtime");
    expect(runtime.calls).toEqual([{ tenant: "acme", runtime: "nomad-eu", sessionId: "bs-1" }]);
    expect(host.calls).toHaveLength(0);
  });

  it("treats no options as the host path (backward-compatible)", async () => {
    const host = recorder("host");
    const runtime = recorder("runtime");
    const r = new RoutingBrowserProvisioner(host.provisioner, runtime.provisioner);
    await r.provision();
    expect(host.calls).toEqual([undefined]);
    expect(runtime.calls).toHaveLength(0);
  });
});
