import type { ServiceHarnessSpec, TrustZone } from "@everdict/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsulClient, ServiceIntention } from "./consul-intentions.js";
import { type NomadExec, type NomadHttp, NomadTopologyRuntime } from "./nomad-runtime.js";
import { SERVICE_GROUP_NAME, servicePortLabel, topologyJobId } from "./nomad-topology.js";

// A portless service → skips ensureTopology's endpoint-discovery (real fetch) loop (unit-test only the pool wiring).
const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "aegra",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "aegra:1", needs: [], perRun: ["thread_id"], replicas: 1, env: {} }],
  dependencies: [{ store: "postgres", role: "checkpoints", purpose: "plumbing", isolateBy: "thread_id" }],
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
    const { registered, execCalls, http, exec } = fakes();
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
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http: http2, exec, pollIntervalMs: 1, maxPolls: 5 });
    await rt.ensureTopology(SPEC, SILO_ZONE);
    // deploys the dedicated store job (zone-suffixed).
    expect(registered.some((j) => j.Job.ID === "everdict-store-aegra-acme")).toBe(true);
    // silo waits for the dedicated store to ACCEPT connections before the services connect (parity with pool + Docker;
    // gap: the silo path used to wait only for the alloc to be running, so a service could connect before initdb finished).
    expect(execCalls.some((c) => c.cmd === "pg_isready")).toBe(true);
    // silo has no per-tenant DDL (the difference from pool).
    expect(execCalls.some((c) => c.cmd === "psql")).toBe(false);
    // DATABASE_URL in the service env uses the discovered host:port (10.1.2.3:41999) (dedicated instance, default creds).
    const topo = registered.find((j) => j.Job.ID === topologyJobId(SPEC, "acme"));
    const env = topo?.Job.TaskGroups[0]?.Tasks[0]?.Env ?? {};
    expect(env.DATABASE_URL).toBe("postgresql://everdict:everdict@10.1.2.3:41999/everdict");
  });
});

describe("NomadTopologyRuntime — no-zone dependency provisioning (gap 1)", () => {
  // Regression: with no trust zone, Nomad used to deploy ZERO declared stores (the isolation branch was gated on
  // `if (zone)`), while Docker always deploys and K8s deploys when provisionDependencies is set. Nomad now honors the
  // same provisionDependencies option → the declared stores come up as a dedicated silo under a "default" id.
  function nzFakes() {
    const registered: Array<{
      Job: { ID: string; TaskGroups: Array<{ Tasks: Array<{ Env: Record<string, string> }> }> };
    }> = [];
    const execCalls: string[] = [];
    const http: NomadHttp = {
      async request(method, path, body) {
        if (method === "POST" && path.startsWith("/v1/jobs")) {
          registered.push(body as (typeof registered)[number]);
          return { status: 200, text: "{}" };
        }
        if (path.includes("/allocations")) {
          return {
            status: 200,
            text: JSON.stringify([
              { TaskGroup: "everdict-store-default-postgres", ClientStatus: "running", ID: "alloc-nz-pg" },
            ]),
          };
        }
        if (path.startsWith("/v1/allocation/")) {
          return {
            status: 200,
            text: JSON.stringify({
              ID: "alloc-nz-pg",
              TaskGroup: "everdict-store-default-postgres",
              AllocatedResources: { Shared: { Ports: [{ Label: "store", Value: 45432, HostIP: "10.9.9.9" }] } },
            }),
          };
        }
        return { status: 200, text: "[]" };
      },
    };
    const exec: NomadExec = {
      async exec(_allocId, _task, command) {
        execCalls.push(command[0] ?? "");
        return "";
      },
    };
    return { registered, execCalls, http, exec };
  }

  it("with provisionDependencies, a no-zone deploy brings the declared stores up as a silo (parity with docker/k8s)", async () => {
    const { registered, execCalls, http, exec } = nzFakes();
    const rt = new NomadTopologyRuntime({
      addr: "http://nomad",
      http,
      exec,
      provisionDependencies: true,
      pollIntervalMs: 1,
      maxPolls: 5,
    });
    await rt.ensureTopology(SPEC); // NO zone

    // deploys the dedicated store job under the no-zone "default" id (pre-fix: nothing was deployed).
    expect(registered.some((j) => j.Job.ID === "everdict-store-aegra-default")).toBe(true);
    // probes the store is accepting before the services connect (gap-4 parity applies to the no-zone silo too).
    expect(execCalls).toContain("pg_isready");
    // injects the discovered store address into the service env.
    const topo = registered.find((j) => j.Job.ID === topologyJobId(SPEC));
    const env = topo?.Job.TaskGroups[0]?.Tasks[0]?.Env ?? {};
    expect(env.DATABASE_URL).toContain("10.9.9.9:45432");
  });

  it("without provisionDependencies, a no-zone deploy provisions no dependency stores (external — the default)", async () => {
    const { registered, http, exec } = nzFakes();
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, pollIntervalMs: 1, maxPolls: 5 });
    await rt.ensureTopology(SPEC); // NO zone, provisionDependencies unset
    expect(registered.some((j) => j.Job.ID.startsWith("everdict-store-"))).toBe(false);
  });
});

describe("NomadTopologyRuntime — single-flight (concurrent ensures)", () => {
  // Regression: the topology job ID is deterministic (everdict-harness-<id>-<version>), so under case-level parallelism
  // (many cases of the same dataset+harness dispatched at once) concurrent ensureTopology calls used to each re-POST the
  // SAME job while the warm entry was still empty — Nomad treats that as a job UPDATE and churns the alloc, so "many
  // cases don't all come up at once". Concurrent ensures must share ONE deploy → the job is registered exactly once.
  it("registers the topology job only once when the same harness is ensured concurrently", async () => {
    const { registered, http, exec } = fakes();
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, pollIntervalMs: 1, maxPolls: 5 });

    const [a, b, c] = await Promise.all([rt.ensureTopology(SPEC), rt.ensureTopology(SPEC), rt.ensureTopology(SPEC)]);

    const topoRegs = registered.filter((j) => j.Job.ID === topologyJobId(SPEC));
    expect(topoRegs).toHaveLength(1); // one POST, not one-per-caller
    expect(a).toBe(b); // all three callers share the single deploy's handle
    expect(b).toBe(c);
  });

  it("re-ensures fresh after a failed deploy (a broken topology is not cached in single-flight)", async () => {
    let firstPost = true;
    const http: NomadHttp = {
      async request(method, path, body) {
        if (method === "POST" && path.startsWith("/v1/jobs")) {
          if (firstPost) {
            firstPost = false;
            return { status: 500, text: "boom" }; // first deploy's registration fails
          }
          return { status: 200, text: "{}" };
        }
        if (path.includes("/allocations")) return { status: 200, text: "[]" };
        return { status: 200, text: "[]" };
      },
    };
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, pollIntervalMs: 1, maxPolls: 5 });
    await expect(rt.ensureTopology(SPEC)).rejects.toThrow(); // inFlight must clear on failure
    await expect(rt.ensureTopology(SPEC)).resolves.toBeDefined(); // else it would fail forever
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

  // Regression (gap 2): a warm entry must be liveness-re-checked on every cache hit. After a reschedule/purge the cached
  // host:port is dead — pre-fix ensureTopology returned the poisoned handle forever (every later case fetch-failed). Now
  // one allocations Get per ensure re-verifies the service group is still running and redeploys when it is gone.
  it("re-verifies warm liveness on a cache hit and redeploys after the alloc is gone", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 200 }) as unknown as Response);
    let allocGone = false;
    let deploys = 0;
    const http: NomadHttp = {
      async request(method, path) {
        if (method === "POST" && path.startsWith("/v1/jobs")) {
          deploys++;
          return { status: 200, text: "{}" };
        }
        if (path.includes("/allocations")) {
          // Only the liveness probe sees "gone" (one shot); the ensuing redeploy's waitForGroupRunning sees it running.
          if (allocGone) {
            allocGone = false;
            return { status: 200, text: "[]" };
          }
          return {
            status: 200,
            text: JSON.stringify([{ TaskGroup: SERVICE_GROUP_NAME, ClientStatus: "running", ID: "alloc-svc" }]),
          };
        }
        if (path.startsWith("/v1/allocation/")) {
          return {
            status: 200,
            text: JSON.stringify({
              ID: "alloc-svc",
              TaskGroup: SERVICE_GROUP_NAME,
              AllocatedResources: {
                Shared: { Ports: [{ Label: servicePortLabel("svc"), Value: 21000, HostIP: "127.0.0.1" }] },
              },
            }),
          };
        }
        return { status: 200, text: "[]" };
      },
    };
    const spec: ServiceHarnessSpec = {
      kind: "service",
      id: "live",
      version: "1.0.0",
      services: [{ name: "svc", image: "a:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} }],
      dependencies: [],
      frontDoor: { service: "svc", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://unused" },
    };
    const rt = new NomadTopologyRuntime({
      addr: "http://nomad",
      http,
      pollIntervalMs: 1,
      maxPolls: 5,
      readyTimeoutMs: 10,
    });

    await rt.ensureTopology(spec);
    expect(deploys).toBe(1);
    // Cache hit while the alloc is running → liveness passes → serve cached, no redeploy.
    await rt.ensureTopology(spec);
    expect(deploys).toBe(1);
    // The alloc is gone (reschedule/purge) → the liveness re-check drops the poisoned entry and redeploys.
    allocGone = true;
    await rt.ensureTopology(spec);
    expect(deploys).toBe(2);
  });
});

describe("NomadTopologyRuntime — per-service endpoint discovery (heterogeneous / scaled)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // When the topology is heterogeneous (or scaled), each service is its OWN group/alloc — so discovery must wait for
  // and resolve EACH per-service group separately (everdict-svc-<name>), not one co-located alloc. (A Windows-node
  // service's alloc discovers on its own node; peers reach it via the injected discovery address.)
  it("waits for each service's own group and merges the endpoints", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 200 }) as unknown as Response);
    const groupsWaited: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        if (method === "POST" && path.startsWith("/v1/jobs")) return { status: 200, text: "{}" };
        if (path.includes("/allocations")) {
          // each service is its own group with its own alloc.
          return {
            status: 200,
            text: JSON.stringify([
              { TaskGroup: "everdict-svc-a", ClientStatus: "running", ID: "alloc-a" },
              { TaskGroup: "everdict-svc-b", ClientStatus: "running", ID: "alloc-b" },
            ]),
          };
        }
        if (path.startsWith("/v1/allocation/")) {
          const id = path.split("/v1/allocation/")[1]?.split("?")[0] ?? "";
          groupsWaited.push(id);
          const port =
            id === "alloc-a"
              ? { Label: "a", Value: 21000, HostIP: "10.0.0.1" }
              : { Label: "b", Value: 21001, HostIP: "10.0.0.2" };
          return {
            status: 200,
            text: JSON.stringify({
              ID: id,
              TaskGroup: id === "alloc-a" ? "everdict-svc-a" : "everdict-svc-b",
              AllocatedResources: { Shared: { Ports: [port] } },
            }),
          };
        }
        return { status: 200, text: "[]" };
      },
    };
    // replicas>1 on `a` makes the topology take the per-service path (heterogeneity trigger, no Windows node needed in the test).
    const spec: ServiceHarnessSpec = {
      kind: "service",
      id: "grid",
      version: "1.0.0",
      services: [
        { name: "a", image: "a:1", port: 8000, needs: [], perRun: [], replicas: 2, env: {} },
        { name: "b", image: "b:1", port: 9000, needs: ["a"], perRun: [], replicas: 1, env: {} },
      ],
      dependencies: [],
      frontDoor: { service: "a", submit: "POST /runs" },
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

    // endpoints resolved from each service's OWN alloc (different host IPs — different nodes).
    expect(handle.endpoints).toEqual({ a: "http://10.0.0.1:21000", b: "http://10.0.0.2:21001" });
    // both per-service allocs were read (not a single co-located one).
    expect(new Set(groupsWaited)).toEqual(new Set(["alloc-a", "alloc-b"]));
  });
});

describe("NomadTopologyRuntime — fixture seed/read (silo)", () => {
  const SILO_ZONE: TrustZone = {
    id: "acme",
    isolationRuntime: "runc",
    network: "deny-cross-tenant",
    trusted: false,
    storeIsolation: "silo",
  };
  const SPEC_DATA: ServiceHarnessSpec = {
    ...SPEC,
    dependencies: [{ store: "postgres", role: "world", purpose: "data", isolateBy: "schema" }],
  };
  // dedicatedStoreGroup("acme", "postgres") — the group == task name for a dedicated store.
  const GROUP = "everdict-store-acme-postgres";

  function siloFakes(execOut = "") {
    const execCalls: Array<{ allocId: string; task: string; command: string[] }> = [];
    const http: NomadHttp = {
      async request(_method, path) {
        if (path.includes("/allocations")) {
          return {
            status: 200,
            text: JSON.stringify([{ TaskGroup: GROUP, ClientStatus: "running", ID: "alloc-silo" }]),
          };
        }
        if (path.startsWith("/v1/allocation/")) {
          return {
            status: 200,
            text: JSON.stringify({ ID: "alloc-silo", TaskGroup: GROUP, AllocatedResources: { Shared: { Ports: [] } } }),
          };
        }
        return { status: 200, text: "[]" };
      },
    };
    const exec: NomadExec = {
      async exec(allocId, task, command) {
        execCalls.push({ allocId, task, command });
        return execOut;
      },
    };
    return { execCalls, http, exec };
  }

  const seedPlan = {
    store: "postgres",
    role: "world",
    isolateBy: "schema",
    slice: "run_run1",
    seed: { inline: "INSERT INTO t VALUES (1);" },
    format: "sql",
  } as const;

  it("seedFixtures: execs the postgres seed in the dedicated store alloc (P2)", async () => {
    const { execCalls, http, exec } = siloFakes();
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, pollIntervalMs: 1, maxPolls: 5 });
    await rt.seedFixtures(SPEC_DATA, "run1", [seedPlan], SILO_ZONE);
    const call = execCalls.find((c) => c.allocId === "alloc-silo");
    expect(call?.task).toBe(GROUP);
    expect(call?.command[0]).toBe("psql");
    expect(call?.command[call.command.length - 1]).toContain('CREATE SCHEMA IF NOT EXISTS "run_run1"');
  });

  it("readStoreState: reads the slice via alloc exec and returns stdout (P2)", async () => {
    const { http, exec } = siloFakes("1|alice\n");
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, pollIntervalMs: 1, maxPolls: 5 });
    const out = await rt.readStoreState(
      SPEC_DATA,
      "run1",
      { store: "postgres", role: "world", query: "SELECT id FROM t" },
      SILO_ZONE,
    );
    expect(out).toBe("1|alice\n");
  });

  it("seedFixtures: rejects seeding without a zone (a dedicated store is zone-keyed)", async () => {
    const { http, exec } = siloFakes();
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, pollIntervalMs: 1, maxPolls: 5 });
    await expect(rt.seedFixtures(SPEC_DATA, "run1", [seedPlan])).rejects.toThrow(/zone/);
  });

  it("seedFixtures: pool store — seeds via the shared store alloc (P2)", async () => {
    const { execCalls, http, exec } = fakes();
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http, exec, pollIntervalMs: 1, maxPolls: 5 });
    await rt.ensureTopology(SPEC_DATA, POOL_ZONE); // provisions the shared store → populates the alloc map
    const before = execCalls.length;
    await rt.seedFixtures(SPEC_DATA, "run1", [seedPlan], POOL_ZONE);
    const seed = execCalls.slice(before).find((c) => c.cmd === "psql");
    expect(seed?.task).toBe("everdict-shared-postgres"); // routed to the cluster-shared store
  });
});

// A9 — warm-topology reclamation. teardown() existed but had NO caller (no TTL, no supersede eviction), so version
// iteration left every superseded warm job running until the cluster ran out of capacity.
describe("NomadTopologyRuntime — warm-topology idle reclamation", () => {
  function recordingHttp(): { calls: Array<{ method: string; path: string }>; http: NomadHttp } {
    const calls: Array<{ method: string; path: string }> = [];
    const http: NomadHttp = {
      async request(method, path) {
        calls.push({ method, path });
        return { status: 200, text: "[]" };
      },
    };
    return { calls, http };
  }

  it("sweepIdle tears down a warm topology idle past the TTL (job deregistered) and the next ensure redeploys", async () => {
    const { calls, http } = recordingHttp();
    let t = 0;
    const rt = new NomadTopologyRuntime({
      addr: "http://nomad",
      http,
      pollIntervalMs: 1,
      maxPolls: 2,
      warmIdleTtlMs: 0, // self-timer off — sweeps driven explicitly for determinism
      now: () => t,
    });
    await rt.ensureTopology(SPEC);
    // Given no traffic for longer than the TTL
    t = 10 * 60_000;
    // When swept — Then the idle entry is torn down (deregistered with purge) and reported
    const reclaimed = await rt.sweepIdle(5 * 60_000);
    expect(reclaimed).toEqual([`${SPEC.id}@${SPEC.version}@default`]);
    expect(calls.some((c) => c.method === "DELETE" && c.path.includes(topologyJobId(SPEC)))).toBe(true);
    // And the next ensure redeploys instead of serving the dead handle
    const posts = calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/jobs")).length;
    await rt.ensureTopology(SPEC);
    expect(calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/jobs")).length).toBe(posts + 1);
  });

  it("an actively-used warm topology is NOT reclaimed — each ensure touches its idle clock", async () => {
    const { calls, http } = recordingHttp();
    let t = 0;
    const rt = new NomadTopologyRuntime({
      addr: "http://nomad",
      http,
      pollIntervalMs: 1,
      maxPolls: 2,
      warmIdleTtlMs: 0,
      now: () => t,
    });
    await rt.ensureTopology(SPEC);
    t = 4 * 60_000;
    await rt.ensureTopology(SPEC); // cache hit → touch
    t = 8 * 60_000; // 8 min after deploy, but only 4 min after the last use
    expect(await rt.sweepIdle(5 * 60_000)).toEqual([]);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

// A6 — service-health diagnosis: an OOM-looping service (exit 137) burned the whole case budget while the drive
// reported only "did not finish within the budget"; diagnose() names the OOM + restarts from the alloc task states.
describe("NomadTopologyRuntime.diagnose", () => {
  const diagHttp = (taskStates: Record<string, { Restarts?: number; Events?: unknown[] }>): NomadHttp => ({
    async request(_method, path) {
      if (path.includes("/allocations")) return { status: 200, text: JSON.stringify([{ TaskStates: taskStates }]) };
      return { status: 200, text: "[]" };
    },
  });

  it("names an OOM-killed (exit 137) service with its restart count", async () => {
    const rt = new NomadTopologyRuntime({
      addr: "http://nomad",
      http: diagHttp({
        "agent-server": { Restarts: 3, Events: [{ Type: "Terminated", DisplayMessage: "Exit Code: 137" }] },
        "browser-mcp": { Restarts: 0, Events: [{ Type: "Started" }] },
      }),
    });
    const health = await rt.diagnose(SPEC);
    expect(health).toContain("agent-server: OOM-killed (exit 137), restarts=3");
    expect(health).not.toContain("browser-mcp");
  });

  it("names restart churn without an OOM signature (last described event carried)", async () => {
    const rt = new NomadTopologyRuntime({
      addr: "http://nomad",
      http: diagHttp({
        "agent-server": {
          Restarts: 2,
          Events: [{ Type: "Terminated", DisplayMessage: "Exit Code: 1" }],
        },
      }),
    });
    expect(await rt.diagnose(SPEC)).toBe("agent-server: restarts=2 — Exit Code: 1");
  });

  it("returns undefined when nothing is notable (healthy topology) or the API errors", async () => {
    const healthy = new NomadTopologyRuntime({
      addr: "http://nomad",
      http: diagHttp({ "agent-server": { Restarts: 0, Events: [{ Type: "Started" }] } }),
    });
    expect(await healthy.diagnose(SPEC)).toBeUndefined();
    const erroring = new NomadTopologyRuntime({
      addr: "http://nomad",
      http: {
        async request() {
          return { status: 500, text: "" };
        },
      },
    });
    expect(await erroring.diagnose(SPEC)).toBeUndefined();
  });
});

describe("NomadTopologyRuntime.describeTopology / serviceLogs (topology observability)", () => {
  it("rosters every task of the topology job with state/restarts/OOM verdict and the placed node", async () => {
    const http: NomadHttp = {
      async request(_method, path) {
        if (path.includes("/allocations"))
          return {
            status: 200,
            text: JSON.stringify([
              {
                ClientStatus: "running",
                DesiredStatus: "run",
                CreateIndex: 5,
                NodeName: "worker-1",
                TaskStates: {
                  "agent-server": {
                    State: "running",
                    Restarts: 0,
                    Events: [{ Type: "Started", DisplayMessage: "Task started by client" }],
                  },
                  "aegra-postgres": {
                    State: "pending",
                    Restarts: 4,
                    Events: [{ Type: "Terminated", DisplayMessage: "Exit Code: 137" }],
                  },
                },
              },
            ]),
          };
        return { status: 404, text: "" };
      },
    };
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http });
    const topo = await rt.describeTopology(SPEC);
    expect(topo?.deployed).toBe(true);
    expect(topo?.runtime).toBe("nomad");
    // The declared identity (role/image) is unioned with the live task state.
    expect(topo?.services.find((s) => s.name === "agent-server")).toMatchObject({
      role: "service",
      image: "aegra:1",
      status: "running",
      ready: true,
      node: "worker-1",
    });
    expect(topo?.services.find((s) => s.name === "aegra-postgres")).toMatchObject({
      role: "store",
      status: "pending",
      ready: false,
      restarts: 4,
      oom: true,
      lastEvent: "Exit Code: 137",
    });
  });

  it("a declared store rosters from its SEPARATE silo job (live-caught: the topology job carries no store task)", async () => {
    // Regression (live Nomad): dependency stores deploy via provisionSilo as everdict-store-<id>-default — a
    // roster that reads only the topology job showed a RUNNING redis as "absent" and its logs as empty.
    const http: NomadHttp = {
      async request(_method, path) {
        if (path.includes("everdict-store-aegra-default/allocations"))
          return {
            status: 200,
            text: JSON.stringify([
              {
                ID: "silo1",
                DesiredStatus: "run",
                CreateIndex: 3,
                NodeName: "worker-1",
                TaskStates: {
                  "everdict-store-default-postgres": { State: "running", Restarts: 0, Events: [{ Type: "Started" }] },
                },
              },
            ]),
          };
        if (path.includes("/allocations"))
          return {
            status: 200,
            text: JSON.stringify([
              {
                ID: "a1",
                DesiredStatus: "run",
                CreateIndex: 5,
                TaskStates: { "agent-server": { State: "running", Events: [] } },
              },
            ]),
          };
        if (path.startsWith("/v1/allocation/silo1"))
          return {
            status: 200,
            text: JSON.stringify({
              AllocatedResources: {
                Tasks: { "everdict-store-default-postgres": { Cpu: { CpuShares: 1000 }, Memory: { MemoryMB: 1024 } } },
              },
            }),
          };
        return { status: 404, text: "" };
      },
    };
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http });
    const topo = await rt.describeTopology(SPEC);
    expect(topo?.services.find((s) => s.role === "store")).toMatchObject({
      status: "running",
      ready: true,
      node: "worker-1",
      cpu: 1000,
      memoryMb: 1024,
    });
  });

  it("serviceLogs for a declared store reads the SILO job's store task, not the topology job", async () => {
    const calls: string[] = [];
    const http: NomadHttp = {
      async request(_method, path) {
        calls.push(path);
        if (path.includes("everdict-store-aegra-default/allocations"))
          return {
            status: 200,
            text: JSON.stringify([
              {
                ID: "silo1",
                DesiredStatus: "run",
                CreateIndex: 1,
                TaskStates: { "everdict-store-default-postgres": { State: "running" } },
              },
            ]),
          };
        if (path.includes("/logs/silo1") && path.includes("type=stdout"))
          return { status: 200, text: "PostgreSQL init done" };
        if (path.includes("/logs/silo1")) return { status: 200, text: "" };
        return { status: 404, text: "" };
      },
    };
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http });
    // SPEC declares a postgres dependency → its declared row name is aegra-postgres (storeName).
    const text = await rt.serviceLogs(SPEC, "aegra-postgres");
    expect(text).toBe("PostgreSQL init done");
    expect(calls.some((c) => c.includes("everdict-store-aegra-default/allocations"))).toBe(true);
    expect(calls.some((c) => c.includes("task=everdict-store-default-postgres"))).toBe(true);
  });

  it("a 404 job reads as an honest deployed:false with the DECLARED units rostered absent; an API failure as undefined", async () => {
    const gone = new NomadTopologyRuntime({
      addr: "http://nomad",
      http: {
        async request() {
          return { status: 404, text: "job not found" };
        },
      },
    });
    const topo = await gone.describeTopology(SPEC);
    expect(topo?.deployed).toBe(false);
    // The declared identity still rosters (role/image/port) so the reader sees WHAT should be standing.
    expect(topo?.services.find((s) => s.name === "agent-server")).toMatchObject({
      role: "service",
      status: "absent",
      image: "aegra:1",
    });
    expect(topo?.services.some((s) => s.role === "store")).toBe(true);
    const erroring = new NomadTopologyRuntime({
      addr: "http://nomad",
      http: {
        async request() {
          return { status: 500, text: "" };
        },
      },
    });
    expect(await erroring.describeTopology(SPEC)).toBeUndefined();
  });

  it("serviceLogs tails the task's stdout and appends its stderr when present", async () => {
    const http: NomadHttp = {
      async request(_method, path) {
        if (path.includes("/allocations"))
          return {
            status: 200,
            text: JSON.stringify([
              { ID: "a1", DesiredStatus: "run", CreateIndex: 1, TaskStates: { "agent-server": { State: "running" } } },
            ]),
          };
        if (path.includes("/logs/a1") && path.includes("type=stdout")) return { status: 200, text: "srv out" };
        if (path.includes("/logs/a1") && path.includes("type=stderr")) return { status: 200, text: "srv err" };
        return { status: 404, text: "" };
      },
    };
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http });
    expect(await rt.serviceLogs(SPEC, "agent-server")).toBe("srv out\n--- stderr ---\nsrv err");
    // A task no alloc carries → undefined (nothing to read), never a throw.
    expect(await rt.serviceLogs(SPEC, "no-such-service")).toBeUndefined();
  });

  it("serviceLogs asks Nomad for only the log TAIL (origin=end + byte offset) — never the whole alloc log file", async () => {
    // Regression: the read used to omit origin/offset, so Nomad streamed the ENTIRE stdout+stderr of a
    // long-lived service into the control plane's memory — large enough logs killed the API server.
    const logReads: string[] = [];
    const http: NomadHttp = {
      async request(_method, path) {
        if (path.includes("/allocations"))
          return {
            status: 200,
            text: JSON.stringify([
              { ID: "a1", DesiredStatus: "run", CreateIndex: 1, TaskStates: { "agent-server": { State: "running" } } },
            ]),
          };
        if (path.includes("/logs/a1")) {
          logReads.push(path);
          return { status: 200, text: "tail" };
        }
        return { status: 404, text: "" };
      },
    };
    const rt = new NomadTopologyRuntime({ addr: "http://nomad", http });
    await rt.serviceLogs(SPEC, "agent-server");
    expect(logReads).toHaveLength(2); // stdout + stderr
    for (const read of logReads) {
      expect(read).toContain("origin=end");
      expect(read).toMatch(/offset=\d+/);
    }
  });
});

// B5 — store probe demotion: over the CLI, "store not ready" and a broken exec path (no nomad binary / no ACL /
// no probe binary in the image) reject identically, and the old hard fail bricked healthy deploys.
describe("NomadTopologyRuntime — store probe is best-effort", () => {
  it("an exec path that can never probe no longer fails the deploy after the budget (demote, then proceed)", async () => {
    // Silo path (no zone, provisionDependencies) — no tenant DDL, so the throwing exec exercises ONLY the probe.
    // The allocations list also carries a STALE failed alloc so the currency fix is exercised on the same poll.
    const siloGroup = "everdict-store-default-postgres"; // dedicatedStoreGroup("default", "postgres")
    const http: NomadHttp = {
      async request(_method, path) {
        if (path.includes("/allocations")) {
          return {
            status: 200,
            text: JSON.stringify([
              { ID: "a-old", TaskGroup: siloGroup, ClientStatus: "failed", CreateIndex: 1 },
              { ID: "a-new", TaskGroup: siloGroup, ClientStatus: "running", CreateIndex: 2 },
            ]),
          };
        }
        if (path.startsWith("/v1/allocation/")) {
          return {
            status: 200,
            text: JSON.stringify({
              ID: "a-new",
              TaskGroup: siloGroup,
              AllocatedResources: { Shared: { Ports: [{ Label: "store", Value: 35432, HostIP: "10.0.0.7" }] } },
            }),
          };
        }
        return { status: 200, text: "[]" };
      },
    };
    const exec: NomadExec = {
      async exec() {
        throw new Error("spawn nomad ENOENT"); // no nomad CLI on the control plane — the probe can NEVER pass
      },
    };
    // Pre-fix: UpstreamError "Timed out waiting for the store to become ready" after the probe budget
    // (and, separately, the stale failed alloc alone threw "Topology alloc failed" on the first poll).
    await expect(
      new NomadTopologyRuntime({
        addr: "http://nomad",
        http,
        exec,
        pollIntervalMs: 1,
        maxPolls: 2,
        provisionDependencies: true,
      }).ensureTopology(SPEC),
    ).resolves.toBeDefined();
  });
});
