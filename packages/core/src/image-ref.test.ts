import { describe, expect, it } from "vitest";
import { BadRequestError } from "./errors.js";
import {
  classifyImageRef,
  dockerAuthConfigJson,
  imageRegistryPrefix,
  imageUsesRegistryHost,
  parseImageRef,
} from "./image-ref.js";

const acme = { host: "ghcr.io", namespace: "acme" };

describe("parseImageRef — docker reference 문법 분해", () => {
  it("호스트는 첫 컴포넌트에 '.'/':'/localhost 일 때만 인식된다", () => {
    expect(parseImageRef("ghcr.io/acme/agent:v3")).toEqual({ host: "ghcr.io", path: "acme/agent", tag: "v3" });
    expect(parseImageRef("localhost:5000/agent:dev")).toEqual({ host: "localhost:5000", path: "agent", tag: "dev" });
    // org/name — 첫 컴포넌트가 호스트 조건을 못 채우면 전체가 경로(docker.io 암시)
    expect(parseImageRef("mendhak/http-https-echo:latest")).toEqual({
      path: "mendhak/http-https-echo",
      tag: "latest",
    });
  });

  it("호스트 포트의 ':' 와 태그의 ':' 를 혼동하지 않는다", () => {
    expect(parseImageRef("registry.acme.dev:5000/team/app")).toEqual({
      host: "registry.acme.dev:5000",
      path: "team/app",
    });
  });

  it("다이제스트(@sha256:…)는 태그와 별개로 분리된다", () => {
    expect(parseImageRef("ghcr.io/acme/agent@sha256:abc")).toEqual({
      host: "ghcr.io",
      path: "acme/agent",
      digest: "sha256:abc",
    });
  });

  it("빈 참조는 BadRequest — 조용한 기본값 없음", () => {
    expect(() => parseImageRef("  ")).toThrow(BadRequestError);
  });
});

describe("classifyImageRef — 복수 레지스트리(어느 하나에 속하면 workspace)", () => {
  const many = [{ host: "ghcr.io", namespace: "acme" }, { host: "registry.acme.dev:5000" }];
  it("등록된 레지스트리 중 하나와 매칭되면 workspace, 아니면 external", () => {
    expect(classifyImageRef("ghcr.io/acme/agent:v3", many)).toBe("workspace");
    expect(classifyImageRef("registry.acme.dev:5000/anything:1", many)).toBe("workspace");
    expect(classifyImageRef("ghcr.io/other/agent:v3", many)).toBe("external");
    expect(classifyImageRef("docker.io/lib/x:1", many)).toBe("external");
  });
  it("빈 배열은 미등록과 동일(workspace 클래스 없음) — 단수 인자와 하위호환", () => {
    expect(classifyImageRef("ghcr.io/acme/agent:v3", [])).toBe("external");
    expect(classifyImageRef("ghcr.io/acme/agent:v3", { host: "ghcr.io", namespace: "acme" })).toBe("workspace");
  });
});

describe("classifyImageRef — 워크스페이스 레지스트리 관점의 4분류", () => {
  it("워크스페이스 레지스트리(host+namespace 일치) → workspace", () => {
    expect(classifyImageRef("ghcr.io/acme/agent:v3", acme)).toBe("workspace");
    expect(classifyImageRef("ghcr.io/acme/deep/nested:1", acme)).toBe("workspace");
  });

  it("같은 호스트라도 namespace 가 다르면 워크스페이스 밖(external)", () => {
    expect(classifyImageRef("ghcr.io/other/agent:v3", acme)).toBe("external");
    // namespace 프리픽스의 부분 문자열은 매치가 아니다(acme vs acme2)
    expect(classifyImageRef("ghcr.io/acme2/agent:v3", acme)).toBe("external");
  });

  it("namespace 없는 레지스트리는 호스트만으로 workspace 매치", () => {
    expect(classifyImageRef("registry.acme.dev:5000/anything:1", { host: "registry.acme.dev:5000" })).toBe("workspace");
  });

  it("루프백 호스트(localhost/127.0.0.1) → local — 그 머신 밖에선 없음", () => {
    expect(classifyImageRef("localhost:5000/agent:dev", acme)).toBe("local");
    expect(classifyImageRef("127.0.0.1/x:1", acme)).toBe("local");
  });

  it("명시 외부 호스트·org/name(docker.io 암시) → external", () => {
    expect(classifyImageRef("quay.io/x/y:1", acme)).toBe("external");
    expect(classifyImageRef("mendhak/http-https-echo:latest", acme)).toBe("external");
  });

  it("단일 세그먼트(로컬 빌드인지 Hub library 인지 모호) → unqualified", () => {
    expect(classifyImageRef("spreadsheetbench:v1", acme)).toBe("unqualified");
    expect(classifyImageRef("postgres:16-alpine", acme)).toBe("unqualified");
  });

  it("레지스트리 미등록 워크스페이스에서도 local/external/unqualified 분류는 동작한다", () => {
    expect(classifyImageRef("ghcr.io/acme/agent:v3")).toBe("external");
    expect(classifyImageRef("localhost:5000/agent:dev")).toBe("local");
    expect(classifyImageRef("spreadsheetbench:v1")).toBe("unqualified");
  });
});

describe("imageRegistryPrefix — 대상 ref 조립용 프리픽스", () => {
  it("namespace 유무에 따라 host[/namespace]/ 를 만든다", () => {
    expect(imageRegistryPrefix(acme)).toBe("ghcr.io/acme/");
    expect(imageRegistryPrefix({ host: "registry.acme.dev:5000" })).toBe("registry.acme.dev:5000/");
  });
});

describe("imageUsesRegistryHost — 인증 주입 대상 판정(명시 호스트 일치만)", () => {
  it("명시 호스트가 일치할 때만 true — 무호스트(unqualified/org명)는 false", () => {
    expect(imageUsesRegistryHost("ghcr.io/acme/agent:v1", "ghcr.io")).toBe(true);
    expect(imageUsesRegistryHost("quay.io/x/y:1", "ghcr.io")).toBe(false);
    expect(imageUsesRegistryHost("spreadsheetbench:v1", "ghcr.io")).toBe(false);
    expect(imageUsesRegistryHost("mendhak/http-https-echo:latest", "ghcr.io")).toBe(false);
  });
});

describe("dockerAuthConfigJson — 임시 DOCKER_CONFIG 내용(pull/push 공용)", () => {
  it("auths[host].auth = base64(user:pass); username 미지정은 토큰 단독 관례로 assay", () => {
    const parsed = JSON.parse(dockerAuthConfigJson({ host: "ghcr.io", username: "bot", password: "p" }));
    expect(Buffer.from(parsed.auths["ghcr.io"].auth, "base64").toString()).toBe("bot:p");
    const tokenOnly = JSON.parse(dockerAuthConfigJson({ host: "r.io", password: "t" }));
    expect(Buffer.from(tokenOnly.auths["r.io"].auth, "base64").toString()).toBe("assay:t");
  });
});
