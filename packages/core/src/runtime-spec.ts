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

// docker — 케이스를 자기 env 이미지(EvalCase.image; 예: SWE-bench 공식 prebuilt = repo+deps 동봉) 컨테이너에서 실행.
// 단일 호스트의 docker 데몬 사용(클러스터 아님). image = 케이스가 image 를 안 실을 때의 기본 이미지(선택).
export const DockerRuntimeSpecSchema = z.object({
  kind: z.literal("docker"),
  ...base,
  image: z.string().optional(), // 케이스 image 없을 때 기본 컨테이너 이미지
});

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
  // 전체 kubeconfig(YAML)를 담은 SecretStore 키 이름(값 아님). exec-plugin/client-cert 인증처럼 토큰만으로
  // 안 되는 클러스터(EKS/GKE 등)용. 디스패치 시 임시파일(0600)로 materialize → kubectl --kubeconfig, 그 뒤 제거.
  // 인증 우선순위: kubeconfigSecret > (server + authSecret) > context. 이 값도 alloc env 로 새지 않는다.
  kubeconfigSecret: z.string().optional(),
});

// topology — 멀티서비스 토폴로지 하니스(kind:"service", 예: browser-use)를 위한 런타임. orchestrator(nomad|k8s) 위에
// warm 서비스 풀 + per-case 브라우저로 구동하고 OTel/MLflow 에서 트레이스를 당겨 채점한다(@assay/topology
// ServiceTopologyBackend). 토폴로지 모양(services/dependencies/target)은 하니스 spec 이, 여기선 "어느 클러스터 + 어느
// trace source" 만 정의. 클러스터 토큰/kubeconfig 는 SecretStore(authSecret) — 여긴 비-비밀 연결정보만.
export const TopologyRuntimeSpecSchema = z.object({
  kind: z.literal("topology"),
  ...base,
  orchestrator: z.enum(["nomad", "k8s"]),
  addr: z.string().url().optional(), // nomad HTTP endpoint
  context: z.string().optional(), // k8s kubeconfig context
  namespace: z.string().optional(),
  browserImage: z.string().optional(), // per-case 브라우저 이미지(없으면 런타임 기본)
  traceSource: z.object({ kind: z.enum(["otel", "mlflow"]), endpoint: z.string() }), // 트레이스 pull 소스
  authSecret: z.string().optional(), // 클러스터 API 토큰의 SecretStore 키 이름(값 아님)
});

export const RuntimeSpecSchema = z.discriminatedUnion("kind", [
  LocalRuntimeSpecSchema,
  DockerRuntimeSpecSchema,
  NomadRuntimeSpecSchema,
  K8sRuntimeSpecSchema,
  TopologyRuntimeSpecSchema,
]);
export type RuntimeSpec = z.infer<typeof RuntimeSpecSchema>;
