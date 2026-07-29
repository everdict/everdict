import { describe, expect, it } from "vitest";
import {
  buildDockerAuthConfig,
  buildEnvironmentRegistration,
  buildImageTargetRef,
  parsePlatform,
  pickRepoDigest,
  pushImage,
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
    expect(pickRepoDigest(stdout, "ghcr.io/acme/officeqa-env:v3")).toBe("ghcr.io/acme/officeqa-env@sha256:bbb");
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
