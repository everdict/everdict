import type { ServiceHarnessSpec } from "@assay/core";

// warm 토폴로지를 Nomad service 잡으로 렌더 (서비스당 task group; docker + runsc 격리).
// 공유 스토어 엔드포인트는 storeEnv(Consul/static)로 주입. per-run wiring 은 front-door API 로 별도.
interface NomadTopoTask {
  Name: string;
  Driver: string;
  Config: { image: string; runtime?: string };
  Env: Record<string, string>;
  Resources: { CPU: number; MemoryMB: number };
}
export interface NomadTopologyJobSpec {
  Job: {
    ID: string;
    Type: string;
    Namespace?: string;
    Datacenters: string[];
    TaskGroups: Array<{ Name: string; Count: number; Tasks: NomadTopoTask[] }>;
  };
}

export interface NomadTopologyOptions {
  datacenters?: string[];
  runtime?: string; // 격리 런타임 (예: "runsc")
  namespace?: string;
  storeEnv?: Record<string, string>; // 공유 스토어 엔드포인트 등
}

export function buildNomadTopologyJob(spec: ServiceHarnessSpec, opts: NomadTopologyOptions = {}): NomadTopologyJobSpec {
  return {
    Job: {
      ID: `assay-harness-${spec.id}-${spec.version}`,
      Type: "service",
      Namespace: opts.namespace,
      Datacenters: opts.datacenters ?? ["dc1"],
      TaskGroups: spec.services.map((svc) => ({
        Name: svc.name,
        Count: svc.replicas,
        Tasks: [
          {
            Name: svc.name,
            Driver: "docker",
            Config: opts.runtime ? { image: svc.image, runtime: opts.runtime } : { image: svc.image },
            Env: { ...opts.storeEnv },
            Resources: { CPU: 1000, MemoryMB: 1024 },
          },
        ],
      })),
    },
  };
}
