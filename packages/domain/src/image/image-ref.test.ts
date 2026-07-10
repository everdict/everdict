import { BadRequestError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyImageRef,
  dockerAuthConfigJson,
  imageRegistryPrefix,
  imageUsesRegistryHost,
  parseImageRef,
} from "./image-ref.js";

const acme = { host: "ghcr.io", namespace: "acme" };

describe("parseImageRef — docker reference syntax decomposition", () => {
  it("recognizes a host only when the first component has '.'/':'/localhost", () => {
    expect(parseImageRef("ghcr.io/acme/agent:v3")).toEqual({ host: "ghcr.io", path: "acme/agent", tag: "v3" });
    expect(parseImageRef("localhost:5000/agent:dev")).toEqual({ host: "localhost:5000", path: "agent", tag: "dev" });
    // org/name — if the first component fails the host condition, the whole thing is the path (implies docker.io)
    expect(parseImageRef("mendhak/http-https-echo:latest")).toEqual({
      path: "mendhak/http-https-echo",
      tag: "latest",
    });
  });

  it("does not confuse the host-port ':' with the tag ':'", () => {
    expect(parseImageRef("registry.acme.dev:5000/team/app")).toEqual({
      host: "registry.acme.dev:5000",
      path: "team/app",
    });
  });

  it("separates the digest (@sha256:…) apart from the tag", () => {
    expect(parseImageRef("ghcr.io/acme/agent@sha256:abc")).toEqual({
      host: "ghcr.io",
      path: "acme/agent",
      digest: "sha256:abc",
    });
  });

  it("throws BadRequest on an empty reference — no silent default", () => {
    expect(() => parseImageRef("  ")).toThrow(BadRequestError);
  });
});

describe("classifyImageRef — multiple registries (belonging to any one makes it workspace)", () => {
  const many = [{ host: "ghcr.io", namespace: "acme" }, { host: "registry.acme.dev:5000" }];
  it("matches one of the registered registries → workspace, otherwise external", () => {
    expect(classifyImageRef("ghcr.io/acme/agent:v3", many)).toBe("workspace");
    expect(classifyImageRef("registry.acme.dev:5000/anything:1", many)).toBe("workspace");
    expect(classifyImageRef("ghcr.io/other/agent:v3", many)).toBe("external");
    expect(classifyImageRef("docker.io/lib/x:1", many)).toBe("external");
  });
  it("an empty array behaves like unregistered (no workspace class) — backward-compatible with the singular arg", () => {
    expect(classifyImageRef("ghcr.io/acme/agent:v3", [])).toBe("external");
    expect(classifyImageRef("ghcr.io/acme/agent:v3", { host: "ghcr.io", namespace: "acme" })).toBe("workspace");
  });
});

describe("classifyImageRef — the 4 classes from the workspace registry's perspective", () => {
  it("workspace registry (host+namespace match) → workspace", () => {
    expect(classifyImageRef("ghcr.io/acme/agent:v3", acme)).toBe("workspace");
    expect(classifyImageRef("ghcr.io/acme/deep/nested:1", acme)).toBe("workspace");
  });

  it("same host but different namespace is outside the workspace (external)", () => {
    expect(classifyImageRef("ghcr.io/other/agent:v3", acme)).toBe("external");
    // a substring of the namespace prefix is not a match (acme vs acme2)
    expect(classifyImageRef("ghcr.io/acme2/agent:v3", acme)).toBe("external");
  });

  it("a registry with no namespace matches workspace by host alone", () => {
    expect(classifyImageRef("registry.acme.dev:5000/anything:1", { host: "registry.acme.dev:5000" })).toBe("workspace");
  });

  it("loopback host (localhost/127.0.0.1) → local — nonexistent outside that machine", () => {
    expect(classifyImageRef("localhost:5000/agent:dev", acme)).toBe("local");
    expect(classifyImageRef("127.0.0.1/x:1", acme)).toBe("local");
  });

  it("explicit external host / org/name (implies docker.io) → external", () => {
    expect(classifyImageRef("quay.io/x/y:1", acme)).toBe("external");
    expect(classifyImageRef("mendhak/http-https-echo:latest", acme)).toBe("external");
  });

  it("single segment (ambiguous local build vs Hub library) → unqualified", () => {
    expect(classifyImageRef("spreadsheetbench:v1", acme)).toBe("unqualified");
    expect(classifyImageRef("postgres:16-alpine", acme)).toBe("unqualified");
  });

  it("local/external/unqualified classification still works in a workspace with no registered registry", () => {
    expect(classifyImageRef("ghcr.io/acme/agent:v3")).toBe("external");
    expect(classifyImageRef("localhost:5000/agent:dev")).toBe("local");
    expect(classifyImageRef("spreadsheetbench:v1")).toBe("unqualified");
  });
});

describe("imageRegistryPrefix — prefix for assembling the target ref", () => {
  it("builds host[/namespace]/ depending on whether a namespace is present", () => {
    expect(imageRegistryPrefix(acme)).toBe("ghcr.io/acme/");
    expect(imageRegistryPrefix({ host: "registry.acme.dev:5000" })).toBe("registry.acme.dev:5000/");
  });
});

describe("imageUsesRegistryHost — decides the auth-injection target (explicit host match only)", () => {
  it("true only when the explicit host matches — a host-less ref (unqualified/org name) is false", () => {
    expect(imageUsesRegistryHost("ghcr.io/acme/agent:v1", "ghcr.io")).toBe(true);
    expect(imageUsesRegistryHost("quay.io/x/y:1", "ghcr.io")).toBe(false);
    expect(imageUsesRegistryHost("spreadsheetbench:v1", "ghcr.io")).toBe(false);
    expect(imageUsesRegistryHost("mendhak/http-https-echo:latest", "ghcr.io")).toBe(false);
  });
});

describe("dockerAuthConfigJson — temporary DOCKER_CONFIG contents (shared by pull/push)", () => {
  it("auths[host].auth = base64(user:pass); a missing username defaults to everdict per the token-only convention", () => {
    const parsed = JSON.parse(dockerAuthConfigJson({ host: "ghcr.io", username: "bot", password: "p" }));
    expect(Buffer.from(parsed.auths["ghcr.io"].auth, "base64").toString()).toBe("bot:p");
    const tokenOnly = JSON.parse(dockerAuthConfigJson({ host: "r.io", password: "t" }));
    expect(Buffer.from(tokenOnly.auths["r.io"].auth, "base64").toString()).toBe("everdict:t");
  });
});
