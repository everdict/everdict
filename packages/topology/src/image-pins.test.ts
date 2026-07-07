import { BadRequestError, type ServiceHarnessSpec } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { applyImagePins } from "./image-pins.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "topo",
  version: "1.0.0",
  services: [
    { name: "agent", image: "reg/agent:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} },
    { name: "mcp", image: "reg/mcp:1", port: 9000, needs: [], perRun: [], replicas: 1, env: {} },
  ],
  dependencies: [],
  frontDoor: { service: "agent", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://m:5000" },
};

describe("applyImagePins", () => {
  it("핀이 없으면 spec 을 그대로(동일 참조) 반환한다 — 무회귀", () => {
    expect(applyImagePins(SPEC, undefined)).toBe(SPEC);
    expect(applyImagePins(SPEC, {})).toBe(SPEC);
  });

  it("매칭 서비스의 이미지만 override 하고 version 에 결정적 핀 접미사를 붙인다", () => {
    const out = applyImagePins(SPEC, { agent: "reg/agent:2" });
    expect(out.services.find((s) => s.name === "agent")?.image).toBe("reg/agent:2");
    expect(out.services.find((s) => s.name === "mcp")?.image).toBe("reg/mcp:1"); // 미핀 서비스는 그대로
    expect(out.version).toMatch(/^1\.0\.0-pin-[0-9a-f]{8}$/);
    expect(SPEC.services[0]?.image).toBe("reg/agent:1"); // 원본 불변(순수)
  });

  it("같은 핀이면 같은 version 접미사(결정적), 다른 핀이면 다른 접미사 → warm 풀 분리", () => {
    const a1 = applyImagePins(SPEC, { agent: "reg/agent:2" }).version;
    const a2 = applyImagePins(SPEC, { agent: "reg/agent:2" }).version;
    const b = applyImagePins(SPEC, { agent: "reg/agent:3" }).version;
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("키 순서가 달라도 같은 핀이면 같은 접미사(정렬 정규화)", () => {
    const x = applyImagePins(SPEC, { agent: "reg/agent:2", mcp: "reg/mcp:2" }).version;
    const y = applyImagePins(SPEC, { mcp: "reg/mcp:2", agent: "reg/agent:2" }).version;
    expect(x).toBe(y);
  });

  it("토폴로지에 없는 서비스 핀이면 BadRequestError 로 거절한다", () => {
    expect(() => applyImagePins(SPEC, { nope: "reg/x:1" })).toThrow(BadRequestError);
  });
});
