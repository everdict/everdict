import type { ServiceHarnessSpec, TrustZone } from "@assay/core";
import { describe, expect, it } from "vitest";
import { type NomadExec, type NomadHttp, NomadTopologyRuntime } from "./nomad-runtime.js";
import { topologyJobId } from "./nomad-topology.js";

// 포트 없는 서비스 → ensureTopology 의 엔드포인트 발견(실 fetch) 루프를 건너뛴다(pool 와이어링만 단위검증).
const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "aegra",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "aegra:1", needs: [], perRun: ["thread_id"], replicas: 1 }],
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
});
