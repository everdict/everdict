import type { ServiceHarnessSpec } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { dependencyConnEnv, dependencyStores } from "./dependencies.js";
import { wiringVars } from "./environment-manager.js";

// external(BYO) dependency 는 Everdict 가 배포/격리하지 않는다 — 프로비저닝·connEnv·케이스 격리에서 제외.
function spec(dependencies: ServiceHarnessSpec["dependencies"]): ServiceHarnessSpec {
  return {
    kind: "service",
    id: "h",
    version: "1",
    services: [{ name: "planner", image: "p:1", needs: [], perRun: [], replicas: 1, env: {} }],
    dependencies,
    frontDoor: { service: "planner", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://o:4318" },
  };
}

describe("dependencies — external(BYO) 스토어 제외", () => {
  it("external dep 은 dependencyStores 에서 빠진다(컨테이너 미배포)", () => {
    const s = spec([
      { store: "postgres", role: "ckpt", isolateBy: "thread_id" },
      { store: "redis", role: "cache", isolateBy: "external", service: "planner" },
    ]);
    expect(dependencyStores(s).map((d) => d.store)).toEqual(["postgres"]); // redis(external) 제외
  });

  it("external dep 은 connEnv 자동 주입 대상이 아니다(연결=storeEnv)", () => {
    const s = spec([{ store: "redis", role: "cache", isolateBy: "external" }]);
    expect(dependencyConnEnv(s)).toEqual({}); // REDIS_URL 자동 주입 없음
  });

  it("wiringVars 는 external dep 의 격리 변수를 만들지 않는다", () => {
    const deps: ServiceHarnessSpec["dependencies"] = [
      { store: "postgres", role: "ckpt", isolateBy: "thread_id" },
      { store: "redis", role: "cache", isolateBy: "external" },
    ];
    const vars = wiringVars("r1", deps);
    expect(vars.thread_id).toBe("run-r1"); // 격리형은 변수 생성
    expect(vars.key_prefix).toBeUndefined(); // external 은 변수 없음(redis 가 external 이므로)
    expect(vars).toEqual({ run_id: "r1", thread_id: "run-r1" });
  });
});
