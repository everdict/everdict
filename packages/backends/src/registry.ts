import { type AgentJob, BadRequestError, type CaseResult, NotFoundError } from "@assay/core";
import { z } from "zod";
import type { Backend } from "./backend.js";
import { LocalBackend } from "./local.js";
import { NomadBackend } from "./nomad.js";

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
]);
export type BackendConfig = z.infer<typeof BackendConfigSchema>;

export const BackendsConfigSchema = z.object({
  default: z.string().optional(),
  backends: z.array(BackendConfigSchema),
});
export type BackendsConfig = z.infer<typeof BackendsConfigSchema>;

export function buildRegistry(
  cfg: BackendsConfig,
  opts: { secretEnv?: Record<string, string> } = {},
): { registry: BackendRegistry; defaultTarget: string | undefined } {
  const registry = new BackendRegistry();
  for (const b of cfg.backends) {
    if (b.kind === "local") {
      registry.register(b.name, new LocalBackend());
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
