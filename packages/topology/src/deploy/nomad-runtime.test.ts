import type { ServiceHarnessSpec, TrustZone } from "@everdict/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsulClient, ServiceIntention } from "./consul-intentions.js";
import { type NomadExec, type NomadHttp, NomadTopologyRuntime } from "./nomad-runtime.js";
import { SERVICE_GROUP_NAME, topologyJobId } from "./nomad-topology.js";

// A portless service → skips ensureTopology's endpoint-discovery (real fetch) loop (unit-test only the pool wiring).
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
          text: JSON.stringify([{ TaskGroup: "everdict-shared-postgres", ClientStatus: "running", ID: "alloc-pg" }]),
        };
      }
      if (path.startsWith("/v1/allocation/")) {
        return {
          status: 200,
          text: JSON.stringify({
            ID: "alloc-pg",
            TaskGroup: "everdict-shared-postgres",
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

describe("NomadTopologyRuntime — pool store isolation", () => {
  it("deploys the shared store once + mints the tenant DB/role via alloc exec + injects scoped creds with the discovered host:port into the service", async () => {
    const { registered, execCalls, http, exec } = fakes();
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, pollIntervalMs: 1, maxPolls: 5 });
    await rt.ensureTopology(SPEC, POOL_ZONE);

    // registers the shared-store job (one per cluster).
    expect(registered.some((j) => j.Job.ID === "everdict-shared-stores")).toBe(true);
    // pg_isready readiness poll + DDL (psql, stdin) execution.
    expect(execCalls.some((c) => c.cmd === "pg_isready")).toBe(true);
    expect(execCalls.some((c) => c.cmd === "psql" && c.stdin?.includes("CREATE ROLE r_acme"))).toBe(true);
    // injects a scoped DATABASE_URL with the discovered host:port (10.0.0.7:35432) into the topology job's service env.
    const topo = registered.find((j) => j.Job.ID === topologyJobId(SPEC, "acme"));
    const env = topo?.Job.TaskGroups[0]?.Tasks[0]?.Env ?? {};
    expect(env.DATABASE_URL).toMatch(/^postgresql:\/\/r_acme:.+@10\.0\.0\.7:35432\/tenant_acme$/);
  });

  it("applies network-isolation intentions when consul is injected (tenant services + shared store)", async () => {
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
    // tenant-service intention (allow same-tenant + deny *) + shared-store intention.
    const agent = applied.find((i) => i.Name === "t-acme-agent-server");
    expect(agent?.Sources.find((s) => s.Name === "*")?.Action).toBe("deny");
    expect(applied.some((i) => i.Name === "everdict-shared-postgres")).toBe(true);
  });

  it("applies no intentions when consul is not injected (default)", async () => {
    const { http, exec } = fakes();
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, pollIntervalMs: 1, maxPolls: 5 });
    await expect(rt.ensureTopology(SPEC, POOL_ZONE)).resolves.toBeDefined(); // fine without consul
  });

  it("silo: deploys the dedicated store job + injects connEnv into the service with the discovered host:port (no DDL)", async () => {
    const { registered, execCalls, http } = fakes();
    const SILO_ZONE: TrustZone = {
      id: "acme",
      isolationRuntime: "runsc",
      network: "deny-cross-tenant",
      trusted: false,
      storeIsolation: "silo",
    };
    // Augment http to return the dedicated-store group alloc (allocations also matches the dedicated group).
    const http2: NomadHttp = {
      async request(method, path, body) {
        if (path.includes("/allocations")) {
          return {
            status: 200,
            text: JSON.stringify([
              { TaskGroup: "everdict-store-acme-postgres", ClientStatus: "running", ID: "alloc-silo-pg" },
            ]),
          };
        }
        if (path.startsWith("/v1/allocation/")) {
          return {
            status: 200,
            text: JSON.stringify({
              ID: "alloc-silo-pg",
              TaskGroup: "everdict-store-acme-postgres",
              AllocatedResources: { Shared: { Ports: [{ Label: "store", Value: 41999, HostIP: "10.1.2.3" }] } },
            }),
          };
        }
        return http.request(method, path, body);
      },
    };
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http: http2, pollIntervalMs: 1, maxPolls: 5 });
    await rt.ensureTopology(SPEC, SILO_ZONE);
    // deploys the dedicated store job (zone-suffixed).
    expect(registered.some((j) => j.Job.ID === "everdict-store-aegra-acme")).toBe(true);
    // silo has no per-tenant DDL (the difference from pool).
    expect(execCalls.some((c) => c.cmd === "psql")).toBe(false);
    // DATABASE_URL in the service env uses the discovered host:port (10.1.2.3:41999) (dedicated instance, default creds).
    const topo = registered.find((j) => j.Job.ID === topologyJobId(SPEC, "acme"));
    const env = topo?.Job.TaskGroups[0]?.Tasks[0]?.Env ?? {};
    expect(env.DATABASE_URL).toBe("postgresql://everdict:everdict@10.1.2.3:41999/everdict");
  });
});

describe("NomadTopologyRuntime — co-located endpoint discovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Regression: services are now co-located in ONE group, so its ONE alloc carries every service's port (labeled per
  // service). Discovery must wait for that single group once and resolve each service by servicePortLabel(name) — not
  // poll a per-service group (the pre-co-location model, which broke because an independently-rescheduled peer's host
  // port drifted while a baked address stayed stale).
  it("resolves every ported service's endpoint by its label from the single co-located alloc", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 200 }) as unknown as Response); // readiness probe passes immediately
    const groupsPolled: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        if (method === "POST" && path.startsWith("/v1/jobs")) return { status: 200, text: "{}" };
        if (path.includes("/allocations")) {
          // one alloc for the single co-located group.
          return {
            status: 200,
            text: JSON.stringify([{ TaskGroup: SERVICE_GROUP_NAME, ClientStatus: "running", ID: "alloc-svc" }]),
          };
        }
        if (path.startsWith("/v1/allocation/")) {
          groupsPolled.push("alloc-svc");
          // the one alloc's shared ports carry BOTH services, labeled by (sanitized) service name.
          return {
            status: 200,
            text: JSON.stringify({
              ID: "alloc-svc",
              TaskGroup: SERVICE_GROUP_NAME,
              AllocatedResources: {
                Shared: {
                  Ports: [
                    { Label: "agent_server", Value: 21000, HostIP: "127.0.0.1" },
                    { Label: "browser_mcp", Value: 21001, HostIP: "127.0.0.1" },
                  ],
                },
              },
            }),
          };
        }
        return { status: 200, text: "[]" };
      },
    };
    const spec: ServiceHarnessSpec = {
      kind: "service",
      id: "bu",
      version: "1.0.0",
      services: [
        { name: "agent-server", image: "a:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} },
        { name: "browser-mcp", image: "b:1", port: 9000, needs: ["agent-server"], perRun: [], replicas: 1, env: {} },
      ],
      dependencies: [],
      frontDoor: { service: "agent-server", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://unused" },
    };
    const rt = new NomadTopologyRuntime({
      addr: "http://nomad",
      http,
      pollIntervalMs: 1,
      maxPolls: 5,
      readyTimeoutMs: 10,
    });

    const handle = await rt.ensureTopology(spec);

    // both endpoints resolved from the ONE shared alloc, keyed by service name.
    expect(handle.endpoints).toEqual({
      "agent-server": "http://127.0.0.1:21000",
      "browser-mcp": "http://127.0.0.1:21001",
    });
    // the single co-located alloc was read once (not a separate group alloc per service).
    expect(new Set(groupsPolled)).toEqual(new Set(["alloc-svc"]));
  });
});
