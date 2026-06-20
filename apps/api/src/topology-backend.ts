import type { Backend } from "@assay/backends";
import { BadRequestError, type RuntimeSpec } from "@assay/core";
import type { HarnessRegistry } from "@assay/registry";
import {
  K8sTopologyRuntime,
  NomadTopologyRuntime,
  ServiceTopologyBackend,
  type TopologyRuntime,
} from "@assay/topology";
import { buildTraceSource } from "@assay/trace";

// topology RuntimeSpec → ServiceTopologyBackend(Backend). @assay/backends 는 @assay/topology 를 의존할 수 없어서(순환:
// topology 가 backends 의 Backend 를 구현) 이 와이어링은 둘 다 의존하는 apps/api 에 둔다. RuntimeDispatcher 가
// 토폴로지 런타임을 만나면 이걸로 백엔드를 빌드해 Scheduler 레지스트리에 올린다(nomad/k8s 와 동일한 라우팅 경로).
// 클러스터 구동(deploy/drive/trace pull)은 라이브 — 테넌트 Nomad/K8s + browser-use 이미지가 필요(Phase 2). 여기선 구성만.
export function buildTopologyBackend(
  spec: Extract<RuntimeSpec, { kind: "topology" }>,
  deps: { harnesses: HarnessRegistry },
): Backend {
  const runtime: TopologyRuntime =
    spec.orchestrator === "nomad"
      ? new NomadTopologyRuntime({
          addr: spec.addr ?? "",
          ...(spec.namespace ? { namespace: spec.namespace } : {}),
          ...(spec.browserImage ? { browserImage: spec.browserImage } : {}),
        })
      : new K8sTopologyRuntime({
          ...(spec.context ? { context: spec.context } : {}),
          ...(spec.namespace ? { namespacePrefix: spec.namespace } : {}),
          ...(spec.browserImage ? { browserImage: spec.browserImage } : {}),
        });
  const traceSource = buildTraceSource({ kind: spec.traceSource.kind, endpoint: spec.traceSource.endpoint });
  return new ServiceTopologyBackend({
    runtime,
    traceSource,
    // 토폴로지 모양(services/dependencies/target)은 하니스(kind:"service")에서. 서비스 하니스가 아니면 거부.
    specFor: async (tenant, id, version) => {
      const h = await deps.harnesses.get(tenant, id, version);
      if (h.kind !== "service") {
        throw new BadRequestError(
          "BAD_REQUEST",
          { harness: id, kind: h.kind },
          "topology 런타임은 kind:service 하니스가 필요합니다.",
        );
      }
      return h;
    },
  });
}
