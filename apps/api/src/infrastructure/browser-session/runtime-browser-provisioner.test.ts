import { BadRequestError, NotFoundError, type RuntimeSpec, type TrustZone } from "@everdict/contracts";
import { NomadRuntimeSpecSchema } from "@everdict/contracts";
import { perTenantTrustZones } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { ProvisionedBrowser } from "../../common/browser-session-provisioner.js";
import { RuntimeBrowserProvisioner } from "./runtime-browser-provisioner.js";

const nomadSpec: RuntimeSpec = NomadRuntimeSpecSchema.parse({
  kind: "nomad",
  id: "nomad-eu",
  version: "1",
  addr: "http://nomad.internal:4646",
  image: "ghcr.io/everdict/agent:1",
});
const zones = perTenantTrustZones();

describe("RuntimeBrowserProvisioner", () => {
  it("resolves the tenant runtime + delegates provisioning with the tenant trust zone", async () => {
    const seen: { spec?: RuntimeSpec; sessionId?: string; zone?: TrustZone } = {};
    const p = new RuntimeBrowserProvisioner({
      resolveSpec: async (tenant, id) => (tenant === "acme" && id === "nomad-eu" ? nomadSpec : undefined),
      zoneFor: (tenant) => zones.resolve(tenant),
      provisionOnRuntime: async (spec, sessionId, zone): Promise<ProvisionedBrowser> => {
        seen.spec = spec;
        seen.sessionId = sessionId;
        seen.zone = zone;
        return { cdpBase: "http://10.0.0.5:23456", dispose: async () => {} };
      },
    });
    const b = await p.provision({ tenant: "acme", runtime: "nomad-eu", sessionId: "bs-1" });
    expect(b.cdpBase).toBe("http://10.0.0.5:23456");
    expect(seen.spec).toBe(nomadSpec);
    expect(seen.sessionId).toBe("bs-1");
    // the browser runs in acme's own trust zone (per-tenant namespace) — isolation from other tenants' sessions.
    expect(seen.zone?.namespace).toBe("everdict-acme");
  });

  it("404s when the tenant has no such runtime — nothing is provisioned", async () => {
    let provisioned = false;
    const p = new RuntimeBrowserProvisioner({
      resolveSpec: async () => undefined,
      zoneFor: (tenant) => zones.resolve(tenant),
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
      resolveSpec: async () => nomadSpec,
      zoneFor: (tenant) => zones.resolve(tenant),
      provisionOnRuntime: async () => ({ cdpBase: "x", dispose: async () => {} }),
    });
    await expect(p.provision({ tenant: "acme", sessionId: "bs-1" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(p.provision({ runtime: "nomad-eu", sessionId: "bs-1" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(p.provision({ tenant: "acme", runtime: "nomad-eu" })).rejects.toBeInstanceOf(BadRequestError);
  });
});
