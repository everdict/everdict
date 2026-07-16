import type { WorkspaceSettings } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";
import { ProxyService } from "./proxy-service.js";

// Minimal partial-merge settings store (mirrors the Pg/InMemory merge semantics) for the unit tests.
function fakeSettings(): WorkspaceSettingsStore {
  const byWs = new Map<string, WorkspaceSettings>();
  return {
    async get(ws) {
      return byWs.get(ws);
    },
    async set(ws, patch) {
      const next = { ...(byWs.get(ws) ?? {}), ...patch };
      byWs.set(ws, next);
      return next;
    },
  };
}

function svc(secrets: Record<string, string> = {}) {
  return new ProxyService({ settings: fakeSettings(), secretsFor: async () => secrets });
}

describe("ProxyService", () => {
  it("upserts by name (declarative full replace) and lists proxies with the secret redacted (name-ref only)", async () => {
    const s = svc();
    await s.upsert("acme", { name: "us-1", country: "US", url: "http://proxy.us:8080", authSecretName: "us_creds" });
    await s.upsert("acme", { name: "de-1", country: "DE", url: "proxy.de:3128" });
    const withAuth = await s.list("acme");
    expect(withAuth.find((p) => p.name === "us-1")?.authSecretName).toBe("us_creds"); // name-ref, not the value
    // re-upsert same name replaces (not duplicate); omitting authSecretName drops it (declarative full replace)
    await s.upsert("acme", { name: "us-1", country: "US", url: "http://proxy.us:9090" });
    const list = await s.list("acme");
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.name === "us-1")).toEqual({ name: "us-1", country: "US", url: "http://proxy.us:9090" });
  });

  it("warns when the referenced auth secret is not set yet (missingSecrets)", async () => {
    const s = svc({}); // no secrets
    const res = await s.upsert("acme", { name: "us-1", country: "US", url: "p:1", authSecretName: "missing" });
    expect(res.missingSecrets).toEqual(["missing"]);
    const ok = await svc({ present: "x" }).upsert("acme", { name: "u", country: "US", url: "p:1", authSecretName: "present" });
    expect(ok.missingSecrets).toBeUndefined();
  });

  it("removes a proxy by name", async () => {
    const s = svc();
    await s.upsert("acme", { name: "us-1", country: "US", url: "p:1" });
    await s.remove("acme", "us-1");
    expect(await s.list("acme")).toHaveLength(0);
  });

  it("resolves a country to the --proxy-server value, folding auth in when configured", async () => {
    const s = svc({ us_creds: "user:pass" });
    await s.upsert("acme", { name: "us-1", country: "US", url: "http://proxy.us:8080", authSecretName: "us_creds" });
    await s.upsert("acme", { name: "de-1", country: "DE", url: "proxy.de:3128" }); // no auth, no scheme
    expect(await s.resolve("acme", "US")).toBe("http://user:pass@proxy.us:8080");
    expect(await s.resolve("acme", "DE")).toBe("proxy.de:3128"); // unchanged (no auth)
    expect(await s.resolve("acme", "JP")).toBeUndefined(); // no proxy for this country
  });

  it("resolves without auth when the referenced secret is missing (best-effort)", async () => {
    const s = svc({}); // secret not present
    await s.upsert("acme", { name: "us-1", country: "US", url: "http://proxy.us:8080", authSecretName: "us_creds" });
    expect(await s.resolve("acme", "US")).toBe("http://proxy.us:8080");
  });
});
