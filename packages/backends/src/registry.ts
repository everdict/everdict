import { type AgentJob, BadRequestError, type CaseResult, NotFoundError, type RuntimeSpec } from "@assay/core";
import { z } from "zod";
import type { Backend } from "./backend.js";
import { DockerBackend } from "./docker-backend.js";
import { K8sBackend, type K8sBackendOptions } from "./k8s.js";
import { LocalBackend } from "./local.js";
import { NomadBackend, type NomadBackendOptions } from "./nomad.js";

// 이름 → Backend 인스턴스. 1 인스턴스 = 1 타깃(클러스터/풀).
// 여러 Nomad/K8s/Windows 타깃은 각각 별개 인스턴스로 등록한다.
export class BackendRegistry {
  private readonly map = new Map<string, Backend>();

  register(name: string, backend: Backend): this {
    this.map.set(name, backend);
    return this;
  }

  get(name: string): Backend {
    const backend = this.map.get(name);
    if (!backend)
      throw new NotFoundError("NOT_FOUND", { backend: name }, `백엔드 '${name}' 가 등록되어 있지 않습니다.`);
    return backend;
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  names(): string[] {
    return [...this.map.keys()];
  }
}

// 컨트롤플레인: 잡의 placement.target(없으면 default)으로 백엔드를 골라 dispatch.
export class Router {
  constructor(
    private readonly registry: BackendRegistry,
    private readonly defaultTarget?: string,
  ) {}

  // async: 동기 throw 를 rejection 으로 일관되게 만든다(호출부는 await/.catch 로 처리).
  async dispatch(job: AgentJob): Promise<CaseResult> {
    const target = job.evalCase.placement?.target ?? this.defaultTarget;
    if (!target) {
      throw new BadRequestError("BAD_REQUEST", undefined, "placement.target 또는 default 백엔드가 필요합니다.");
    }
    return this.registry.get(target).dispatch(job);
  }
}

// --- 설정에서 레지스트리 구성 (여러 클러스터/풀 선언; 외부 입력이라 Zod 검증) ---
export const BackendConfigSchema = z.discriminatedUnion("kind", [
  z.object({ name: z.string(), kind: z.literal("local") }),
  z.object({
    name: z.string(),
    kind: z.literal("nomad"),
    addr: z.string(),
    image: z.string(),
    runtime: z.string().optional(),
    datacenters: z.array(z.string()).optional(),
  }),
  z.object({
    name: z.string(),
    kind: z.literal("k8s"),
    image: z.string(),
    context: z.string().optional(), // kubeconfig 컨텍스트(예: kind-assay)
    namespace: z.string().optional(),
    runtimeClass: z.string().optional(), // gVisor=gvisor 등
  }),
]);
export type BackendConfig = z.infer<typeof BackendConfigSchema>;

export const BackendsConfigSchema = z.object({
  default: z.string().optional(),
  backends: z.array(BackendConfigSchema),
});
export type BackendsConfig = z.infer<typeof BackendsConfigSchema>;

// 시크릿맵에서 한 키를 제외한 새 맵(없으면 그대로). 클러스터 API 토큰을 alloc env 에서 분리할 때 쓴다.
function withoutKey(
  env: Record<string, string> | undefined,
  key: string | undefined,
): Record<string, string> | undefined {
  if (!env || !key || !(key in env)) return env;
  const { [key]: _omitted, ...rest } = env;
  return rest;
}

// RuntimeSpec(nomad) + 테넌트 시크릿맵 → NomadBackendOptions.
// authSecret(이름)은 Nomad API(ACL) 토큰으로 풀려 X-Nomad-Token 으로 쓰이고, alloc env 에서는 제외(에이전트에 노출 금지).
export function nomadRuntimeOptions(
  spec: Extract<RuntimeSpec, { kind: "nomad" }>,
  secretEnv?: Record<string, string>,
): NomadBackendOptions {
  const apiToken = spec.authSecret ? secretEnv?.[spec.authSecret] : undefined;
  const allocEnv = withoutKey(secretEnv, spec.authSecret);
  return {
    addr: spec.addr,
    image: spec.image,
    ...(spec.runtime ? { runtime: spec.runtime } : {}),
    ...(spec.datacenters ? { datacenters: spec.datacenters } : {}),
    ...(spec.namespace ? { namespace: spec.namespace } : {}),
    ...(apiToken ? { apiToken } : {}),
    ...(allocEnv && Object.keys(allocEnv).length > 0 ? { secretEnv: allocEnv } : {}),
  };
}

// RuntimeSpec(k8s) + 테넌트 시크릿맵 → K8sBackendOptions. authSecret 은 K8s API bearer 토큰으로 풀려(server 와 함께) alloc env 에서 제외.
export function k8sRuntimeOptions(
  spec: Extract<RuntimeSpec, { kind: "k8s" }>,
  secretEnv?: Record<string, string>,
): K8sBackendOptions {
  const apiToken = spec.authSecret ? secretEnv?.[spec.authSecret] : undefined;
  const allocEnv = withoutKey(secretEnv, spec.authSecret);
  return {
    image: spec.image,
    ...(spec.context ? { context: spec.context } : {}),
    ...(spec.namespace ? { namespace: spec.namespace } : {}),
    ...(spec.runtimeClass ? { runtimeClass: spec.runtimeClass } : {}),
    ...(spec.server ? { server: spec.server } : {}),
    ...(apiToken ? { apiToken } : {}),
    ...(allocEnv && Object.keys(allocEnv).length > 0 ? { secretEnv: allocEnv } : {}),
  };
}

// 테넌트가 등록한 RuntimeSpec(@assay/core) → 라이브 Backend. 모델/클러스터 자격증명은 secretEnv 로 주입(스펙엔 비밀 없음).
// 클러스터 API 토큰(authSecret)은 인증 헤더로 쓰이고 alloc env 에서는 분리된다(위 옵션 빌더).
// 컨트롤플레인이 디스패치 시 이걸로 테넌트 런타임을 만들어 Scheduler 레지스트리에 올린다.
export function buildRuntimeBackend(spec: RuntimeSpec, opts: { secretEnv?: Record<string, string> } = {}): Backend {
  if (spec.kind === "local") return new LocalBackend();
  if (spec.kind === "docker") return new DockerBackend(spec.image ? { image: spec.image } : {});
  if (spec.kind === "k8s") return new K8sBackend(k8sRuntimeOptions(spec, opts.secretEnv));
  if (spec.kind === "nomad") return new NomadBackend(nomadRuntimeOptions(spec, opts.secretEnv));
  // topology 는 @assay/topology 의 ServiceTopologyBackend 가 필요(순환 의존 불가) → apps/api 의 buildBackend 가 처리한다.
  throw new BadRequestError(
    "BAD_REQUEST",
    { kind: spec.kind },
    `buildRuntimeBackend 는 '${spec.kind}' 를 직접 빌드하지 않습니다(topology 는 apps/api buildBackend 경유).`,
  );
}

export function buildRegistry(
  cfg: BackendsConfig,
  opts: { secretEnv?: Record<string, string> } = {},
): { registry: BackendRegistry; defaultTarget: string | undefined } {
  const registry = new BackendRegistry();
  for (const b of cfg.backends) {
    if (b.kind === "local") {
      registry.register(b.name, new LocalBackend());
    } else if (b.kind === "k8s") {
      registry.register(
        b.name,
        new K8sBackend({
          image: b.image,
          context: b.context,
          namespace: b.namespace,
          runtimeClass: b.runtimeClass,
          secretEnv: opts.secretEnv,
        }),
      );
    } else {
      registry.register(
        b.name,
        new NomadBackend({
          addr: b.addr,
          image: b.image,
          runtime: b.runtime,
          datacenters: b.datacenters,
          secretEnv: opts.secretEnv,
        }),
      );
    }
  }
  return { registry, defaultTarget: cfg.default };
}
