import { BadRequestError, NotFoundError, type RuntimeSpec } from "@everdict/contracts";
import { NomadRuntimeSpecSchema } from "@everdict/contracts";
import { perTenantTrustZones } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { ProvisionedBrowser } from "../../common/browser-session-provisioner.js";
import type { ResolvedRuntime } from "../../common/runtime-compute.js";
import { RuntimeBrowserProvisioner } from "./runtime-browser-provisioner.js";

const nomadSpec: RuntimeSpec = NomadRuntimeSpecSchema.parse({
  kind: "nomad",
  id: "nomad-eu",
  version: "1",
  addr: "http://nomad.internal:4646",
  image: "ghcr.io/everdict/agent:1",
});
const zones = perTenantTrustZones();
// What the shared resolver hands back: the spec, the cluster credential it looked up, and the tenant's zone.
const resolved = (tenant: string): ResolvedRuntime => ({
  tenant,
  spec: nomadSpec,
  secretEnv: {},
  apiToken: "acl-token",
  zone: zones.resolve(tenant),
});

describe("RuntimeBrowserProvisioner", () => {
  it("resolves the tenant runtime + delegates provisioning with the tenant trust zone", async () => {
    const seen: { runtime?: ResolvedRuntime; sessionId?: string } = {};
    const p = new RuntimeBrowserProvisioner({
      resolve: async (tenant, id) => (tenant === "acme" && id === "nomad-eu" ? resolved(tenant) : undefined),
      provisionOnRuntime: async (runtime, sessionId): Promise<ProvisionedBrowser> => {
        seen.runtime = runtime;
        seen.sessionId = sessionId;
        return { cdpBase: "http://10.0.0.5:23456", dispose: async () => {} };
      },
    });
    const b = await p.provision({ tenant: "acme", runtime: "nomad-eu", sessionId: "bs-1" });
    expect(b.cdpBase).toBe("http://10.0.0.5:23456");
    expect(seen.runtime?.spec).toBe(nomadSpec);
    expect(seen.sessionId).toBe("bs-1");
    // the browser runs in acme's own trust zone (per-tenant namespace) — isolation from other tenants' sessions.
    expect(seen.runtime?.zone?.namespace).toBe("everdict-acme");
    // and the cluster credential rides along, so an ACL-enabled Nomad is reachable at all.
    expect(seen.runtime?.apiToken).toBe("acl-token");
  });

  it("404s when the tenant has no such runtime — nothing is provisioned", async () => {
    let provisioned = false;
    const p = new RuntimeBrowserProvisioner({
      resolve: async () => undefined,
      provisionOnRuntime: async () => {
        provisioned = true;
        return { cdpBase: "x", dispose: async () => {} };
      },
    });
    await expect(p.provision({ tenant: "acme", runtime: "ghost", sessionId: "bs-1" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(provisioned).toBe(false);
  });

  it("rejects a call missing the tenant / runtime / session id (defense in depth over the router)", async () => {
    const p = new RuntimeBrowserProvisioner({
      resolve: async (tenant) => resolved(tenant),
      provisionOnRuntime: async () => ({ cdpBase: "x", dispose: async () => {} }),
    });
    await expect(p.provision({ tenant: "acme", sessionId: "bs-1" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(p.provision({ runtime: "nomad-eu", sessionId: "bs-1" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(p.provision({ tenant: "acme", runtime: "nomad-eu" })).rejects.toBeInstanceOf(BadRequestError);
  });
});
