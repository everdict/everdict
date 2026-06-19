import { z } from "zod";

// Runtime — 테넌트가 등록하는 실행 인프라 정의("어디서 eval 이 도나"). local | nomad | k8s.
// 등록 가능한 1급 엔티티(소유/버전/lifecycle 은 하니스·데이터셋·judge 와 동일 패턴, 불변 버전 SSOT).
// ⚠️ 비밀 금지 — Nomad 토큰/kubeconfig 같은 자격증명은 테넌트 SecretStore 에서 주입(디스패치 시). 여기엔 비-비밀 연결정보만.
// @assay/backends 의 BackendConfig 와 같은 필드(이름 대신 id/version) — buildRuntimeBackend 가 이걸 라이브 Backend 로 만든다.

const base = {
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
};

export const LocalRuntimeSpecSchema = z.object({ kind: z.literal("local"), ...base });

export const NomadRuntimeSpecSchema = z.object({
  kind: z.literal("nomad"),
  ...base,
  addr: z.string().url(), // Nomad HTTP endpoint (예: http://nomad.internal:4646)
  image: z.string(), // 러너 에이전트 이미지(테넌트 레지스트리)
  runtime: z.string().optional(), // docker 격리 런타임(예: runsc=gVisor)
  datacenters: z.array(z.string()).optional(),
  namespace: z.string().optional(),
  // 컨트롤플레인↔Nomad API 인증(ACL)용 토큰의 SecretStore 키 이름 — X-Nomad-Token 헤더로 쓰인다.
  // 값(토큰)이 아니라 이름만. 이 토큰은 alloc env 로 주입되지 않는다(클러스터 토큰을 에이전트에 노출 금지).
  authSecret: z.string().optional(),
});

export const K8sRuntimeSpecSchema = z.object({
  kind: z.literal("k8s"),
  ...base,
  image: z.string(),
  context: z.string().optional(), // kubeconfig 컨텍스트(컨트롤플레인 호스트 기준) — 로컬 kubeconfig 인증
  namespace: z.string().optional(),
  runtimeClass: z.string().optional(), // runtimeClassName(gVisor=gvisor 등)
  server: z.string().url().optional(), // 외부 API 서버 URL(context 대신 bearer 토큰으로 인증할 때)
  // K8s API bearer 토큰의 SecretStore 키 이름(server 와 함께 — kubectl --token). 값이 아니라 이름만; alloc env 로 새지 않는다.
  authSecret: z.string().optional(),
});

export const RuntimeSpecSchema = z.discriminatedUnion("kind", [
  LocalRuntimeSpecSchema,
  NomadRuntimeSpecSchema,
  K8sRuntimeSpecSchema,
]);
export type RuntimeSpec = z.infer<typeof RuntimeSpecSchema>;
