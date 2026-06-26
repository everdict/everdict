import type { ServiceHarnessSpec, TrustZone } from "@assay/core";
import { describe, expect, it } from "vitest";
import type { ConsulClient, ServiceIntention } from "./consul-intentions.js";
import { type NomadExec, type NomadHttp, NomadTopologyRuntime } from "./nomad-runtime.js";
import { topologyJobId } from "./nomad-topology.js";

// 포트 없는 서비스 → ensureTopology 의 엔드포인트 발견(실 fetch) 루프를 건너뛴다(pool 와이어링만 단위검증).
const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "aegra",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "aegra:1", needs: [], perRun: ["thread_id"], replicas: 1, env: {} }],
  dependencies: [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};
const POOL_ZONE: TrustZone = {
  id: "acme",
  isolationRuntime: "runc",
  network: "deny-cross-tenant",
  trusted: true,
  storeIsolation: "pool",
};

function fakes() {
  const registered: Array<{
    Job: { ID: string; TaskGroups: Array<{ Tasks: Array<{ Env: Record<string, string> }> }> };
  }> = [];
  const execCalls: Array<{ task: string; cmd: string; stdin?: string }> = [];
  const http: NomadHttp = {
    async request(method, path, body) {
      if (method === "POST" && path.startsWith("/v1/jobs")) {
        registered.push(body as (typeof registered)[number]);
        return { status: 200, text: "{}" };
      }
      if (path.includes("/allocations")) {
        return {
          status: 200,
          text: JSON.stringify([{ TaskGroup: "assay-shared-postgres", ClientStatus: "running", ID: "alloc-pg" }]),
        };
      }
      if (path.startsWith("/v1/allocation/")) {
        return {
          status: 200,
          text: JSON.stringify({
            ID: "alloc-pg",
            TaskGroup: "assay-shared-postgres",
            AllocatedResources: { Shared: { Ports: [{ Label: "store", Value: 35432, HostIP: "10.0.0.7" }] } },
          }),
        };
      }
      return { status: 200, text: "[]" };
    },
  };
  const exec: NomadExec = {
    async exec(_allocId, task, command, opts) {
      execCalls.push({ task, cmd: command[0] ?? "", stdin: opts?.stdin });
      return "";
    },
  };
  return { registered, execCalls, http, exec };
}

describe("NomadTopologyRuntime — pool 스토어 격리", () => {
  it("공유 스토어 1회 배포 + alloc exec 로 테넌트 DB/role mint + 서비스에 발견된 host:port scoped creds 주입", async () => {
    const { registered, execCalls, http, exec } = fakes();
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, pollIntervalMs: 1, maxPolls: 5 });
    await rt.ensureTopology(SPEC, POOL_ZONE);

    // 공유 스토어 잡(클러스터 1개) 등록.
    expect(registered.some((j) => j.Job.ID === "assay-shared-stores")).toBe(true);
    // pg_isready 준비 폴링 + DDL(psql, stdin) 실행.
    expect(execCalls.some((c) => c.cmd === "pg_isready")).toBe(true);
    expect(execCalls.some((c) => c.cmd === "psql" && c.stdin?.includes("CREATE ROLE r_acme"))).toBe(true);
    // 토폴로지 잡 서비스 env 에 발견된 host:port(10.0.0.7:35432) 로 scoped DATABASE_URL 주입.
    const topo = registered.find((j) => j.Job.ID === topologyJobId(SPEC, "acme"));
    const env = topo?.Job.TaskGroups[0]?.Tasks[0]?.Env ?? {};
    expect(env.DATABASE_URL).toMatch(/^postgresql:\/\/r_acme:.+@10\.0\.0\.7:35432\/tenant_acme$/);
  });

  it("consul 주입 시 네트워크 격리 intention 적용(테넌트 서비스 + 공유 스토어)", async () => {
    const { http, exec } = fakes();
    const applied: ServiceIntention[] = [];
    const consul: ConsulClient = {
      async applyIntention(e) {
        applied.push(e);
      },
      async deleteIntention() {},
    };
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, consul, pollIntervalMs: 1, maxPolls: 5 });
    await rt.ensureTopology(SPEC, POOL_ZONE);
    // 테넌트 서비스 intention(같은 테넌트 allow + * deny) + 공유 스토어 intention.
    const agent = applied.find((i) => i.Name === "t-acme-agent-server");
    expect(agent?.Sources.find((s) => s.Name === "*")?.Action).toBe("deny");
    expect(applied.some((i) => i.Name === "assay-shared-postgres")).toBe(true);
  });

  it("consul 미주입 시 intention 미적용(기본)", async () => {
    const { http, exec } = fakes();
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, pollIntervalMs: 1, maxPolls: 5 });
    await expect(rt.ensureTopology(SPEC, POOL_ZONE)).resolves.toBeDefined(); // consul 없이도 정상
  });

  it("silo: 전용 스토어 잡 배포 + 발견된 host:port 로 서비스에 connEnv 주입(DDL 없음)", async () => {
    const { registered, execCalls, http } = fakes();
    const SILO_ZONE: TrustZone = {
      id: "acme",
      isolationRuntime: "runsc",
      network: "deny-cross-tenant",
      trusted: false,
      storeIsolation: "silo",
    };
    // 전용 스토어 그룹 alloc 을 돌려주도록 http 를 보강(allocations 가 dedicated 그룹도 매칭).
    const http2: NomadHttp = {
      async request(method, path, body) {
        if (path.includes("/allocations")) {
          return {
            status: 200,
            text: JSON.stringify([
              { TaskGroup: "assay-store-acme-postgres", ClientStatus: "running", ID: "alloc-silo-pg" },
            ]),
          };
        }
        if (path.startsWith("/v1/allocation/")) {
          return {
            status: 200,
            text: JSON.stringify({
              ID: "alloc-silo-pg",
              TaskGroup: "assay-store-acme-postgres",
              AllocatedResources: { Shared: { Ports: [{ Label: "store", Value: 41999, HostIP: "10.1.2.3" }] } },
            }),
          };
        }
        return http.request(method, path, body);
      },
    };
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http: http2, pollIntervalMs: 1, maxPolls: 5 });
    await rt.ensureTopology(SPEC, SILO_ZONE);
    // 전용 스토어 잡(zone-suffixed) 배포.
    expect(registered.some((j) => j.Job.ID === "assay-store-aegra-acme")).toBe(true);
    // silo 는 per-tenant DDL 없음(pool 과 차이).
    expect(execCalls.some((c) => c.cmd === "psql")).toBe(false);
    // 서비스 env 에 발견된 host:port(10.1.2.3:41999) 로 DATABASE_URL(전용 인스턴스, 기본 creds).
    const topo = registered.find((j) => j.Job.ID === topologyJobId(SPEC, "acme"));
    const env = topo?.Job.TaskGroups[0]?.Tasks[0]?.Env ?? {};
    expect(env.DATABASE_URL).toBe("postgresql://assay:assay@10.1.2.3:41999/assay");
  });
});
