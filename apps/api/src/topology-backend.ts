import type { Backend } from "@everdict/backends";
import { BadRequestError, type RegistryAuth, type RuntimeSpec } from "@everdict/core";
import type { HarnessInstanceRegistry } from "@everdict/registry";
import {
  type CallbackRendezvous,
  K8sTopologyRuntime,
  NomadTopologyRuntime,
  ServiceTopologyBackend,
  type TopologyRuntime,
} from "@everdict/topology";
import { buildTraceSource } from "@everdict/trace";

// topology-capable nomad/k8s RuntimeSpec → ServiceTopologyBackend(Backend). @everdict/backends 는 @everdict/topology 를
// 의존할 수 없어서(순환) 이 와이어링은 둘 다 의존하는 apps/api 에 둔다. traceSource 를 가진 nomad/k8s 런타임을
// 만나면(옛 topology kind 대신 — slice 5b-2) 이걸로 백엔드를 빌드해 Scheduler 레지스트리에 올린다.
// orchestrator 는 이제 런타임 kind(nomad|k8s) 에서 암시. 클러스터 구동은 라이브(테넌트 Nomad/K8s + browser-use 이미지).
export function buildTopologyBackend(
  spec: Extract<RuntimeSpec, { kind: "nomad" | "k8s" }>,
  deps: {
    harnesses: HarnessInstanceRegistry;
    callbackRendezvous?: CallbackRendezvous;
    // 워크스페이스 이미지 레지스트리 pull 자격증명(빌드 시점 resolve) — 서비스 이미지 인증 pull
    // (nomad docker auth / k8s dockerconfigjson Secret + imagePullSecrets).
    registryAuth?: RegistryAuth;
  },
): Backend {
  const ts = spec.traceSource;
  if (!ts) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { runtime: spec.id, kind: spec.kind },
      "topology 백엔드는 traceSource 설정이 필요합니다(이 런타임은 topology-capable 이 아닙니다).",
    );
  }
  const runtime: TopologyRuntime =
    spec.kind === "nomad"
      ? new NomadTopologyRuntime({
          addr: spec.addr,
          ...(spec.namespace ? { namespace: spec.namespace } : {}),
          ...(spec.browserImage ? { browserImage: spec.browserImage } : {}),
          ...(deps.registryAuth ? { registryAuth: deps.registryAuth } : {}),
        })
      : new K8sTopologyRuntime({
          ...(spec.context ? { context: spec.context } : {}),
          ...(spec.namespace ? { namespacePrefix: spec.namespace } : {}),
          ...(spec.browserImage ? { browserImage: spec.browserImage } : {}),
          ...(deps.registryAuth ? { registryAuth: deps.registryAuth } : {}),
        });
  const traceSource = buildTraceSource({ kind: ts.kind, endpoint: ts.endpoint });
  return new ServiceTopologyBackend({
    runtime,
    traceSource,
    // callback 완료 모델의 랑데부(있으면) — {{callback_url}} 발급 + inbound 대기. 같은 인스턴스를 control-plane 라우트가 deliver.
    ...(deps.callbackRendezvous ? { callbackRendezvous: deps.callbackRendezvous } : {}),
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
