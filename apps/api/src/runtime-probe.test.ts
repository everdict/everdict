import type { Backend, ProbeResult } from "@assay/backends";
import type { RuntimeSpec } from "@assay/core";
import { describe, expect, it } from "vitest";
import { makeRuntimeProber } from "./runtime-probe.js";

const SPEC: RuntimeSpec = { kind: "local", id: "rt", version: "1.0.0", tags: [] };

function stubBackend(probe?: () => Promise<ProbeResult>): Backend {
  return {
    id: "stub",
    capacity: async () => ({ total: 1, used: 0 }),
    dispatch: async () => {
      throw new Error("not used");
    },
    ...(probe ? { probe } : {}),
  };
}

describe("makeRuntimeProber", () => {
  it("reachable 백엔드 → {kind,reachable,detail}", async () => {
    const probe = makeRuntimeProber({
      secretsFor: async () => ({}),
      buildBackend: () => stubBackend(async () => ({ reachable: true, detail: "Nomad agent: n1" })),
    });
    expect(await probe("acme", SPEC)).toEqual({ kind: "local", reachable: true, detail: "Nomad agent: n1" });
  });

  it("probe 미지원 백엔드 → reachable:false + 안내", async () => {
    const probe = makeRuntimeProber({ secretsFor: async () => ({}), buildBackend: () => stubBackend() });
    const r = await probe("acme", SPEC);
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("연결 테스트를 지원하지 않습니다");
  });

  it("백엔드 빌드 실패 → reachable:false + 사유", async () => {
    const probe = makeRuntimeProber({
      secretsFor: async () => ({}),
      buildBackend: () => {
        throw new Error("unsupported kind");
      },
    });
    const r = await probe("acme", SPEC);
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("unsupported kind");
  });

  it("시크릿을 그 워크스페이스로 resolve해 빌더 secretEnv 로 넘긴다", async () => {
    let seen: Record<string, string> | undefined;
    const probe = makeRuntimeProber({
      secretsFor: async (ws): Promise<Record<string, string>> => (ws === "acme" ? { NOMAD_TOKEN: "t" } : {}),
      buildBackend: (_spec, opts) => {
        seen = opts.secretEnv;
        return stubBackend(async () => ({ reachable: true, detail: "ok" }));
      },
    });
    await probe("acme", SPEC);
    expect(seen).toEqual({ NOMAD_TOKEN: "t" });
  });

  it("probe 가 응답 없으면 타임아웃으로 reachable:false", async () => {
    const probe = makeRuntimeProber({
      secretsFor: async () => ({}),
      buildBackend: () => stubBackend(() => new Promise<ProbeResult>(() => {})), // 영원히 pending
      timeoutMs: 20,
    });
    const r = await probe("acme", SPEC);
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("시간초과");
  });
});
