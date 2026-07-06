import { describe, expect, it } from "vitest";
import { buildDockerAuthConfig, buildImageTargetRef, pushImage } from "./image-push.js";

const CREDS = {
  host: "ghcr.io",
  namespace: "acme",
  username: "bot",
  password: "tok-123",
  imagePrefix: "ghcr.io/acme/",
};

describe("buildImageTargetRef — 로컬 ref → 워크스페이스 레지스트리 대상 ref", () => {
  it("name/tag 기본값은 로컬 ref 에서 얻는다", () => {
    expect(buildImageTargetRef("ghcr.io/acme/", "spreadsheetbench:v1")).toBe("ghcr.io/acme/spreadsheetbench:v1");
    expect(buildImageTargetRef("ghcr.io/acme/", "localhost:5000/team/agent:dev")).toBe("ghcr.io/acme/agent:dev");
  });

  it("--name/--tag 로 덮어쓸 수 있고, 태그 없는 로컬 ref 는 latest", () => {
    expect(buildImageTargetRef("ghcr.io/acme/", "spreadsheetbench:v1", "sbench", "v2")).toBe("ghcr.io/acme/sbench:v2");
    expect(buildImageTargetRef("registry.acme.dev:5000/", "myimg")).toBe("registry.acme.dev:5000/myimg:latest");
  });
});

describe("buildDockerAuthConfig — 임시 DOCKER_CONFIG 내용", () => {
  it("auths[host].auth = base64(user:pass); username 미지정이면 토큰 단독 관례로 assay", () => {
    const config = JSON.parse(buildDockerAuthConfig(CREDS));
    expect(Buffer.from(config.auths["ghcr.io"].auth, "base64").toString()).toBe("bot:tok-123");
    const tokenOnly = JSON.parse(buildDockerAuthConfig({ host: "r.io", password: "p" }));
    expect(Buffer.from(tokenOnly.auths["r.io"].auth, "base64").toString()).toBe("assay:p");
  });
});

describe("pushImage — tag → 임시 config 로 push → 정리", () => {
  it("docker tag 후 --config <임시디렉터리> push 를 호출하고 발행 ref 를 돌려준다", async () => {
    const calls: string[][] = [];
    const target = await pushImage(CREDS, "spreadsheetbench:v1", {
      io: { log: () => {}, docker: async (args) => void calls.push(args) },
    });
    expect(target).toBe("ghcr.io/acme/spreadsheetbench:v1");
    expect(calls[0]).toEqual(["tag", "spreadsheetbench:v1", "ghcr.io/acme/spreadsheetbench:v1"]);
    expect(calls[1]?.[0]).toBe("--config");
    expect(calls[1]?.slice(2)).toEqual(["push", "ghcr.io/acme/spreadsheetbench:v1"]);
  });

  it("push 가 실패해도 임시 DOCKER_CONFIG 는 정리된다(finally) — 에러는 전파", async () => {
    let configDir: string | undefined;
    await expect(
      pushImage(CREDS, "img:1", {
        io: {
          log: () => {},
          docker: async (args) => {
            if (args[0] === "--config") {
              configDir = args[1];
              throw new Error("push 거부");
            }
          },
        },
      }),
    ).rejects.toThrow("push 거부");
    const { existsSync } = await import("node:fs");
    expect(configDir).toBeDefined();
    expect(configDir && existsSync(configDir)).toBe(false);
  });
});
