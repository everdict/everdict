import { type Backend, type ProbeResult, buildRuntimeBackend } from "@assay/backends";
import type { RuntimeSpec } from "@assay/core";

// 연결 테스트 결과 — 잡 없이 클러스터 도달성/인증만 확인.
export interface RuntimeProbeResult {
  kind: string;
  reachable: boolean;
  detail: string;
}

export interface RuntimeProberDeps {
  // 테넌트 SecretStore → 백엔드 secretEnv(클러스터 토큰/kubeconfig 를 인증 헤더로 resolve; alloc env 엔 안 들어감).
  secretsFor: (workspace: string) => Promise<Record<string, string>>;
  // topology 처럼 buildRuntimeBackend 가 직접 못 만드는 종류는 apps/api 가 주입(없으면 buildRuntimeBackend).
  buildBackend?: (spec: RuntimeSpec, opts: { secretEnv?: Record<string, string> }) => Backend;
  timeoutMs?: number; // 미도달 클러스터에서 무한 대기 방지(기본 10s)
}

// RuntimeSpec → 라이브 백엔드 빌드(테넌트 시크릿으로 클러스터 인증 resolve) → probe() 로 도달성/인증 확인.
// 디스패치와 동일한 빌더/인증 경로를 쓰되 잡은 돌리지 않는다 → 등록 전 "붙는지" 를 그대로 검증.
export function makeRuntimeProber(
  deps: RuntimeProberDeps,
): (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  return async (workspace, spec) => {
    const secretEnv = await deps.secretsFor(workspace).catch(() => ({}) as Record<string, string>);
    const build = deps.buildBackend ?? buildRuntimeBackend;
    let backend: Backend;
    try {
      backend = build(spec, { secretEnv });
    } catch (e) {
      return { kind: spec.kind, reachable: false, detail: e instanceof Error ? e.message : String(e) };
    }
    if (!backend.probe)
      return { kind: spec.kind, reachable: false, detail: `'${spec.kind}' 런타임은 연결 테스트를 지원하지 않습니다.` };
    // 미도달 클러스터의 TCP 타임아웃(수십 초)을 기다리지 않도록 상한.
    const timeout = new Promise<ProbeResult>((resolve) => {
      setTimeout(() => resolve({ reachable: false, detail: `연결 테스트 시간초과(${timeoutMs / 1000}s)` }), timeoutMs);
    });
    const r = await Promise.race([backend.probe(), timeout]);
    return { kind: spec.kind, reachable: r.reachable, detail: r.detail };
  };
}
