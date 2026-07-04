import { z } from "zod";
import { CapabilityNameSchema } from "./capability.js";

// Runtime — 테넌트가 등록하는 실행 인프라 정의("어디서 eval 이 도나"). local | nomad | k8s.
// (docker/topology kind 는 slice 5b 에서 제거 — docker→self-hosted 러너, topology→nomad/k8s 의 traceSource 설정[= topology capability].)
// 등록 가능한 1급 엔티티(소유/버전/lifecycle 은 하니스·데이터셋·judge 와 동일 패턴, 불변 버전 SSOT).
// ⚠️ 비밀 금지 — Nomad 토큰/kubeconfig 같은 자격증명은 테넌트 SecretStore 에서 주입(디스패치 시). 여기엔 비-비밀 연결정보만.
// @assay/backends 의 BackendConfig 와 같은 필드(이름 대신 id/version) — buildRuntimeBackend 가 이걸 라이브 Backend 로 만든다.

const base = {
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  // 이 런타임이 제공하는 capability(선언 또는 probe-탐지) — harness 요구(requiredCapabilities)와 functionalGate 로
  // 매칭한다. self-hosted 러너는 자가-프로브로 광고하고, 등록 런타임(nomad/k8s)은 여기 선언하거나 probe 로 채운다.
  // 미지정이면 미검사(하위호환). 설계: docs/architecture/self-hosted-runtime-and-runners.md.
  capabilities: z.array(CapabilityNameSchema).optional(),
};

// local — 컨트롤플레인 호스트에서 in-process 실행(dev 전용). 컨트롤플레인의 호스트지 "사용자 머신"이 아니다 —
// 워크스페이스 하니스/데이터셋을 자기 머신에서 돌리는 건 self-hosted runner(개인 소유)가 대체한다(docs/architecture/self-hosted-runner.md).
export const LocalRuntimeSpecSchema = z.object({ kind: z.literal("local"), ...base });

// docker(단일 호스트 데몬) 런타임 kind 는 제거됨(slice 5b) — "단일 docker 호스트"는 self-hosted 러너가
// 로컬 docker 로 실행(pull)해 대체한다. 컨테이너 실행 능력은 이제 런타임 kind 가 아니라 `docker` capability 다.

// topology 지원 설정 — nomad/k8s 런타임이 traceSource 를 가지면 멀티서비스 토폴로지 하니스(kind:"service",
// 예: browser-use)를 호스팅한다(→ apps/api 가 ServiceTopologyBackend 로 라우팅; capability 로는 `topology`).
// traceSource 없으면 일반 컴퓨트 런타임. (옛 topology kind 는 slice 5b-2 제거 — orchestrator 는 kind[nomad|k8s]에서 암시.)
const topologyConfig = {
  traceSource: z.object({ kind: z.enum(["otel", "mlflow"]), endpoint: z.string() }).optional(),
  browserImage: z.string().optional(), // per-case 브라우저 이미지(없으면 런타임 기본)
};

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
  ...topologyConfig, // traceSource 있으면 이 Nomad 런타임이 topology(서비스 하니스)를 호스팅
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
  // 전체 kubeconfig(YAML)를 담은 SecretStore 키 이름(값 아님). exec-plugin/client-cert 인증처럼 토큰만으로
  // 안 되는 클러스터(EKS/GKE 등)용. 디스패치 시 임시파일(0600)로 materialize → kubectl --kubeconfig, 그 뒤 제거.
  // 인증 우선순위: kubeconfigSecret > (server + authSecret) > context. 이 값도 alloc env 로 새지 않는다.
  kubeconfigSecret: z.string().optional(),
  ...topologyConfig, // traceSource 있으면 이 K8s 런타임이 topology(서비스 하니스)를 호스팅
});

export const RuntimeSpecSchema = z.discriminatedUnion("kind", [
  LocalRuntimeSpecSchema,
  NomadRuntimeSpecSchema,
  K8sRuntimeSpecSchema,
]);
export type RuntimeSpec = z.infer<typeof RuntimeSpecSchema>;
