import { describe, expect, it } from "vitest";
import { buildDockerAuthConfig, buildImageTargetRef, pushImage } from "./image-push.js";

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
