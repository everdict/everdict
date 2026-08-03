import { describe, expect, it, vi } from "vitest";
import {
  buildDockerAuthConfig,
  buildEnvironmentRegistration,
  buildImageTargetRef,
  fetchManagedPushGrant,
  parsePlatform,
  pickRepoDigest,
  pushImage,
  repositoryNameFor,
} from "./image-push.js";

const CREDS = {
  host: "ghcr.io",
  namespace: "acme",
  username: "bot",
  password: "tok-123",
  imagePrefix: "ghcr.io/acme/",
};

describe("buildImageTargetRef — local ref → workspace registry target ref", () => {
  it("defaults name/tag from the local ref", () => {
    expect(buildImageTargetRef("ghcr.io/acme/", "spreadsheetbench:v1")).toBe("ghcr.io/acme/spreadsheetbench:v1");
    expect(buildImageTargetRef("ghcr.io/acme/", "localhost:5000/team/agent:dev")).toBe("ghcr.io/acme/agent:dev");
  });

  it("can be overridden with --name/--tag, and an untagged local ref defaults to latest", () => {
    expect(buildImageTargetRef("ghcr.io/acme/", "spreadsheetbench:v1", "sbench", "v2")).toBe("ghcr.io/acme/sbench:v2");
    expect(buildImageTargetRef("registry.acme.dev:5000/", "myimg")).toBe("registry.acme.dev:5000/myimg:latest");
  });
});

describe("buildDockerAuthConfig — temporary DOCKER_CONFIG contents", () => {
  it("auths[host].auth = base64(user:pass); without a username, the token-only convention uses everdict", () => {
    const config = JSON.parse(buildDockerAuthConfig(CREDS));
    expect(Buffer.from(config.auths["ghcr.io"].auth, "base64").toString()).toBe("bot:tok-123");
    const tokenOnly = JSON.parse(buildDockerAuthConfig({ host: "r.io", password: "p" }));
    expect(Buffer.from(tokenOnly.auths["r.io"].auth, "base64").toString()).toBe("everdict:p");
  });
});

describe("pickRepoDigest — the pushed digest out of docker's RepoDigests", () => {
  it("picks the digest of the pushed repository, ignoring digests of other repositories", () => {
    const stdout = "docker.io/acme/other@sha256:aaa\nghcr.io/acme/officeqa-env@sha256:bbb\n";
    expect(pickRepoDigest(stdout, "ghcr.io/acme/officeqa-env:v3")).toBe("ghcr.io/acme/officeqa-env:v3@sha256:bbb");
  });

  it("keeps the pushed tag on the pin — docker reports the digest alone, and a tagless pin has no readable version", () => {
    const stdout = "registry.acme.dev:5000/team/env@sha256:ccc";
    expect(pickRepoDigest(stdout, "registry.acme.dev:5000/team/env:2026.7")).toBe(
      "registry.acme.dev:5000/team/env:2026.7@sha256:ccc",
    );
    // An untagged target has nothing to keep — the pin is the digest alone.
    expect(pickRepoDigest("ghcr.io/acme/env@sha256:ddd", "ghcr.io/acme/env")).toBe("ghcr.io/acme/env@sha256:ddd");
  });

  it("is undefined when docker reported no digest for the pushed repository — the caller falls back to the tag", () => {
    expect(pickRepoDigest("", "ghcr.io/acme/officeqa-env:v3")).toBeUndefined();
    expect(pickRepoDigest("ghcr.io/acme/other@sha256:aaa", "ghcr.io/acme/officeqa-env:v3")).toBeUndefined();
  });
});

describe("parsePlatform — the local image's os/arch", () => {
  it("splits the inspect format, and omits what docker did not report", () => {
    expect(parsePlatform("linux|amd64\n")).toEqual({ os: "linux", arch: "amd64" });
    expect(parsePlatform("")).toEqual({});
  });
});

describe("buildEnvironmentRegistration — the pushed ref as a store asset", () => {
  it("defaults name/description/instructions from what the push knows and never invents contents", () => {
    const registration = buildEnvironmentRegistration({
      id: "officeqa-env",
      image: "ghcr.io/acme/officeqa-env@sha256:bbb",
      localRef: "officeqa-env:v3",
      visibility: "workspace",
      os: "linux",
      arch: "amd64",
    });
    expect(registration.name).toBe("officeqa-env");
    expect(registration.description).toContain("officeqa-env:v3");
    expect(registration.spec.image).toBe("ghcr.io/acme/officeqa-env@sha256:bbb");
    expect(registration.spec.contents).toEqual({ packages: [], os: "linux", arch: "amd64" });
    expect(registration.spec.instructions).toContain("officeqa-env:v3"); // provenance only — no fabricated guidance
  });

  it("carries the author's own name/description/benchmark/instructions when given", () => {
    const registration = buildEnvironmentRegistration({
      id: "officeqa-env",
      image: "ghcr.io/acme/officeqa-env:v3",
      localRef: "officeqa-env:v3",
      visibility: "subset",
      name: "OfficeQA environment",
      description: "LibreOffice + python3.12",
      benchmark: "officeqa",
      instructions: "## Entry point\n`/app/run.sh`",
    });
    expect(registration.name).toBe("OfficeQA environment");
    expect(registration.visibility).toBe("subset");
    expect(registration.spec.contents?.benchmark).toBe("officeqa");
    expect(registration.spec.instructions).toContain("/app/run.sh");
  });

  it("omits contents entirely when the push learned nothing about the image", () => {
    const registration = buildEnvironmentRegistration({
      id: "env",
      image: "ghcr.io/acme/env:v1",
      localRef: "env:v1",
      visibility: "private",
    });
    expect(registration.spec.contents).toBeUndefined();
  });
});

describe("pushImage — tag → push with a temporary config → cleanup", () => {
  it("calls docker tag then --config <tempdir> push and returns the published ref", async () => {
    const calls: string[][] = [];
    const target = await pushImage(CREDS, "spreadsheetbench:v1", {
      io: { log: () => {}, docker: async (args) => void calls.push(args) },
    });
    expect(target).toBe("ghcr.io/acme/spreadsheetbench:v1");
    expect(calls[0]).toEqual(["tag", "spreadsheetbench:v1", "ghcr.io/acme/spreadsheetbench:v1"]);
    expect(calls[1]?.[0]).toBe("--config");
    expect(calls[1]?.slice(2)).toEqual(["push", "ghcr.io/acme/spreadsheetbench:v1"]);
  });

  it("cleans up the temporary DOCKER_CONFIG even when push fails (finally) — the error propagates", async () => {
    let configDir: string | undefined;
    await expect(
      pushImage(CREDS, "img:1", {
        io: {
          log: () => {},
          docker: async (args) => {
            if (args[0] === "--config") {
              configDir = args[1];
              throw new Error("push rejected");
            }
          },
        },
      }),
    ).rejects.toThrow("push rejected");
    const { existsSync } = await import("node:fs");
    expect(configDir).toBeDefined();
    expect(configDir && existsSync(configDir)).toBe(false);
  });
});

describe("repositoryNameFor — what a local ref publishes as", () => {
  it("takes the last path segment, and --name wins", () => {
    expect(repositoryNameFor("officeqa-env:v1")).toBe("officeqa-env");
    expect(repositoryNameFor("ghcr.io/acme/officeqa-env:v1")).toBe("officeqa-env");
    expect(repositoryNameFor("officeqa-env:v1", "renamed")).toBe("renamed");
  });
});

describe("fetchManagedPushGrant — managed first, BYO when there is no managed store", () => {
  const grantBody = {
    grant: {
      endpoint: "images.everdict.test",
      repositories: ["acme-1a2b3c4d/officeqa"],
      actions: ["pull", "push"],
      token: "grant-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
    },
    imagePrefix: "images.everdict.test/acme-1a2b3c4d/",
  };

  it("presents the grant as the docker password under the fixed grant username", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(grantBody), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const credentials = await fetchManagedPushGrant("http://cp", "ak_x", "officeqa");
    expect(credentials).toEqual({
      host: "images.everdict.test",
      username: "everdict",
      password: "grant-token",
      imagePrefix: "images.everdict.test/acme-1a2b3c4d/",
    });
    vi.unstubAllGlobals();
  });

  // A deployment with no managed store answers 404 — that is a normal answer here, not a failure: the command
  // falls back to the workspace's BYO registries, which is what every pre-managed workspace still has.
  it("returns undefined on 404 so the caller can fall back to a BYO registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    await expect(fetchManagedPushGrant("http://cp", "ak_x", "officeqa")).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("surfaces a real failure verbatim instead of silently falling back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "images:push denied" }), { status: 403 })),
    );
    await expect(fetchManagedPushGrant("http://cp", "ak_x", "officeqa")).rejects.toThrow("images:push denied");
    vi.unstubAllGlobals();
  });
});
