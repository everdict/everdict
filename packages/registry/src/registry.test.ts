import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, type HarnessSpec, NotFoundError } from "@assay/core";
import { describe, expect, it } from "vitest";
import { loadHarnessDir } from "./load.js";
import { InMemoryHarnessRegistry } from "./registry.js";

const proc = (id: string, version: string): HarnessSpec => ({ kind: "process", id, version });
const svc = (id: string, version: string): HarnessSpec => ({
  kind: "service",
  id,
  version,
  services: [{ name: "agent-server", image: "img", port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://m:5000" },
});

describe("InMemoryHarnessRegistry", () => {
  it("등록 + 정확한 버전 조회", () => {
    const r = new InMemoryHarnessRegistry();
    r.register(proc("claude-code", "1.0.0"));
    expect(r.has("claude-code", "1.0.0")).toBe(true);
    expect(r.get("claude-code", "1.0.0").version).toBe("1.0.0");
  });

  it("latest 는 semver 최신을 가리킨다 (1.10.0 > 1.9.0)", () => {
    const r = new InMemoryHarnessRegistry();
    r.register(proc("h", "1.9.0"));
    r.register(proc("h", "1.10.0"));
    r.register(proc("h", "1.2.0"));
    expect(r.versions("h")).toEqual(["1.2.0", "1.9.0", "1.10.0"]);
    expect(r.get("h").version).toBe("1.10.0"); // 기본 ref = latest
    expect(r.get("h", "latest").version).toBe("1.10.0");
  });

  it("버전은 불변: 동일 스펙 재등록은 멱등, 다른 스펙은 충돌", () => {
    const r = new InMemoryHarnessRegistry();
    r.register(svc("bu", "1.0.0"));
    r.register(svc("bu", "1.0.0")); // 동일 → ok
    const mutated = { ...svc("bu", "1.0.0"), dependencies: [{ store: "redis", role: "x", isolateBy: "key-prefix" }] };
    expect(() => r.register(mutated as HarnessSpec)).toThrow(ConflictError);
  });

  it("getService 는 service 로 좁히고 process 면 거절", () => {
    const r = new InMemoryHarnessRegistry();
    r.register(svc("bu", "1.0.0"));
    r.register(proc("claude-code", "1.0.0"));
    expect(r.getService("bu").id).toBe("bu");
    expect(() => r.getService("claude-code")).toThrow();
  });

  it("미등록 id/version 은 NotFound", () => {
    const r = new InMemoryHarnessRegistry();
    expect(() => r.get("nope")).toThrow(NotFoundError);
    r.register(proc("h", "1.0.0"));
    expect(() => r.get("h", "9.9.9")).toThrow(NotFoundError);
  });

  it("list 는 id 별 정렬된 버전 목록", () => {
    const r = new InMemoryHarnessRegistry();
    r.register(svc("bu", "1.1.0"));
    r.register(svc("bu", "1.0.0"));
    expect(r.list()).toEqual([{ id: "bu", versions: ["1.0.0", "1.1.0"] }]);
  });
});

describe("loadHarnessDir", () => {
  it("디렉터리의 *.json 스펙을 로드한다(파일 SSOT)", () => {
    const dir = mkdtempSync(join(tmpdir(), "assay-reg-"));
    try {
      writeFileSync(join(dir, "bu-1.0.0.json"), JSON.stringify(svc("bu", "1.0.0")));
      writeFileSync(join(dir, "bu-1.1.0.json"), JSON.stringify(svc("bu", "1.1.0")));
      const r = loadHarnessDir(dir);
      expect(r.versions("bu")).toEqual(["1.0.0", "1.1.0"]);
      expect(r.getService("bu").version).toBe("1.1.0"); // latest
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
