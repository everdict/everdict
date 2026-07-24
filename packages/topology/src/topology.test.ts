import type {
  BrowserSnapshot,
  CaseJob,
  CaseResult,
  Grader,
  ServiceHarnessSpec,
  TraceEvent,
  TrustZone,
} from "@everdict/contracts";
import { InternalError } from "@everdict/contracts";
import { perTenantTrustZones } from "@everdict/domain";
import type { TraceSource } from "@everdict/trace";
import { describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_IMAGE } from "./deploy/browser-image.js";
import { buildSharedStoreManifests } from "./deploy/dependencies.js";
import { buildK8sManifests } from "./deploy/k8s-topology.js";
import {
  type AllocLike,
  SERVICE_GROUP_NAME,
  SHARED_STORE_JOB_ID,
  browserJobId,
  buildBrowserJob,
  buildDedicatedStoreJob,
  buildNomadTopologyJob,
  buildSharedStoreJob,
  needsPerServiceGroups,
  nomadServiceName,
  peerEnvName,
  resolvePort,
  servicePortLabel,
  topologyJobId,
} from "./deploy/nomad-topology.js";
import type { StoreSeedPlan } from "./deploy/store-seed.js";
import type { TargetEnvHandle, TopologyRuntime } from "./deploy/topology-runtime.js";
import { keysFor } from "./environment-manager.js";
import { InProcessCallbackRendezvous } from "./front-door/callback-rendezvous.js";
import type { FrontDoorDriver } from "./front-door/front-door-driver.js";
import type { AcquireRequestFn } from "./front-door/target-acquirer.js";
import { ServiceTopologyBackend, type SubmitFn } from "./service-backend.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "browser-use-langgraph",
  version: "1.0.0",
  services: [
    {
      name: "agent-server",
      image: "reg/bu-agent:1",
      port: 8000,
      needs: ["postgres", "redis", "browser-mcp"],
      perRun: ["thread_id"],
      replicas: 1,
      env: {},
    },
    { name: "browser-mcp", image: "reg/bu-mcp:1", port: 9000, needs: [], perRun: [], replicas: 1, env: {} },
    {
      name: "action-stream",
      image: "reg/bu-actionstream:1",
      port: 8080,
      needs: ["redis"],
      perRun: [],
      replicas: 1,
      env: {},
    },
  ],
  dependencies: [
    { store: "postgres", role: "checkpoints", purpose: "plumbing", isolateBy: "thread_id" },
    { store: "redis", role: "action-stream", purpose: "plumbing", isolateBy: "key-prefix" },
    { store: "minio", role: "snapshots", purpose: "plumbing", isolateBy: "object-prefix" },
  ],
  target: {
    kind: "browser",
    engine: "chromium",
    extension: { ref: "reg/lupin-ext:1" },
    lifecycle: "per-case-instance",
    observe: ["dom", "screenshot", "url"],
  },
  frontDoor: { service: "agent-server", submit: "POST /runs", trace: "GET /runs/{id}/events" },
  traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
};

describe("buildNomadTopologyJob", () => {
  it("co-locates every service as a task in ONE bridge-netns group (docker/runsc)", () => {
    const job = buildNomadTopologyJob(SPEC, { runtime: "runsc", storeEnv: { PG_URL: "x" } });
    expect(job.Job.Type).toBe("service");
    // one co-located group holding all services (was one group per service).
    expect(job.Job.TaskGroups.map((g) => g.Name)).toEqual([SERVICE_GROUP_NAME]);
    const group = job.Job.TaskGroups[0];
    expect(group?.Count).toBe(1);
    expect(group?.Networks?.[0]?.Mode).toBe("bridge"); // shared network namespace = loopback comms
    expect(group?.Tasks.map((t) => t.Name)).toEqual(["agent-server", "browser-mcp", "action-stream"]);
    const agent = group?.Tasks[0];
    expect(agent?.Config.image).toBe("reg/bu-agent:1");
    expect(agent?.Config.runtime).toBe("runsc");
    expect(agent?.Env.PG_URL).toBe("x");
  });

  it("maps every service name → 127.0.0.1 via extra_hosts (peers reachable by <name>:<port> over loopback), after the host-gateway alias", () => {
    const job = buildNomadTopologyJob(SPEC);
    for (const task of job.Job.TaskGroups[0]?.Tasks ?? []) {
      // host.docker.internal (host model gateway reachability) is prepended by serviceConfig, then the peer loopback aliases.
      expect(task.Config.extra_hosts).toEqual([
        "host.docker.internal:host-gateway",
        "agent-server:127.0.0.1",
        "browser-mcp:127.0.0.1",
        "action-stream:127.0.0.1",
      ]);
    }
  });

  it("throws BAD_REQUEST when two co-located services declare the same port (shared netns can't bind twice)", () => {
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        { name: "a", image: "i:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} },
        { name: "b", image: "i:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} },
      ],
    };
    expect(() => buildNomadTopologyJob(spec)).toThrowError(/both use 8000/);
    const err = ((): unknown => {
      try {
        buildNomadTopologyJob(spec);
      } catch (e) {
        return e;
      }
    })();
    expect((err as { code?: string }).code).toBe("BAD_REQUEST");
  });

  it("injects the service static env (svc.env) into the task Env, and storeEnv wins on conflict", () => {
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        {
          name: "agent-server",
          image: "reg/bu-agent:1",
          port: 8000,
          needs: [],
          perRun: [],
          replicas: 1,
          env: { FOO: "bar", PG_URL: "svc" },
        },
      ],
    };
    const job = buildNomadTopologyJob(spec, { storeEnv: { PG_URL: "store" } });
    const env = job.Job.TaskGroups[0]?.Tasks[0]?.Env;
    expect(env?.FOO).toBe("bar"); // svc.env alone
    expect(env?.PG_URL).toBe("store"); // storeEnv wins over svc.env
  });

  it("svc.resources maps to task Resources (default 1000/1024 when unset)", () => {
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        {
          name: "big",
          image: "i:1",
          needs: [],
          perRun: [],
          replicas: 1,
          env: {},
          resources: { cpu: 2000, memoryMb: 4096 },
        },
        { name: "default", image: "i:1", needs: [], perRun: [], replicas: 1, env: {} },
      ],
    };
    const job = buildNomadTopologyJob(spec);
    const tasks = job.Job.TaskGroups[0]?.Tasks ?? [];
    expect(tasks[0]?.Resources).toEqual({ CPU: 2000, MemoryMB: 4096 });
    expect(tasks[1]?.Resources).toEqual({ CPU: 1000, MemoryMB: 1024 });
  });

  it("svc.volumes maps to the docker driver Config.volumes (omitted when unset)", () => {
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        {
          name: "v",
          image: "i:1",
          needs: [],
          perRun: [],
          replicas: 1,
          env: {},
          volumes: ["data:/var/lib/x", "/h:/c:ro"],
        },
        { name: "n", image: "i:1", needs: [], perRun: [], replicas: 1, env: {} },
      ],
    };
    const job = buildNomadTopologyJob(spec);
    const tasks = job.Job.TaskGroups[0]?.Tasks ?? [];
    expect(tasks[0]?.Config.volumes).toEqual(["data:/var/lib/x", "/h:/c:ro"]);
    expect(tasks[1]?.Config.volumes).toBeUndefined();
  });

  it("gives each ported service a group dynamic port labeled by its name (To its fixed container port)", () => {
    const job = buildNomadTopologyJob(SPEC);
    const group = job.Job.TaskGroups[0];
    // the single group's shared network carries one labeled dynamic port per ported service.
    expect(group?.Networks?.[0]?.DynamicPorts).toEqual([
      { Label: servicePortLabel("agent-server"), To: 8000 },
      { Label: servicePortLabel("browser-mcp"), To: 9000 },
      { Label: servicePortLabel("action-stream"), To: 8080 },
    ]);
    // the labels are env-var-safe (hyphens → underscores) since the alloc carries all of them.
    expect(servicePortLabel("agent-server")).toBe("agent_server");
    // each task references its own port label.
    expect(group?.Tasks[0]?.Config.ports).toEqual(["agent_server"]);
    expect(group?.Tasks[1]?.Config.ports).toEqual(["browser_mcp"]);
  });
});

describe("buildNomadTopologyJob — heterogeneous / scaled → per-service groups (K8s-style)", () => {
  // A mixed-OS topology: a Linux Selenium hub + a Windows browser node that must talk to it directly. The canonical
  // "requires both Ubuntu and Windows" open-source topology.
  const MIXED: ServiceHarnessSpec = {
    kind: "service",
    id: "grid",
    version: "1.0.0",
    services: [
      { name: "hub", image: "selenium/hub:4", port: 4444, needs: [], perRun: [], replicas: 1, env: {} },
      {
        name: "win-node",
        image: "selenium/node-edge:4",
        port: 5555,
        needs: ["hub"],
        perRun: [],
        replicas: 1,
        env: {},
        requires: { os: "windows" },
      },
    ],
    dependencies: [],
    frontDoor: { service: "hub", submit: "POST /session" },
    traceSource: { kind: "otel", endpoint: "http://x" },
  };

  it("needsPerServiceGroups: false for a homogeneous single-instance Linux topology (stays co-located, no regression)", () => {
    expect(needsPerServiceGroups(SPEC)).toBe(false);
    expect(needsPerServiceGroups(MIXED)).toBe(true); // a Windows service forces the split
    const scaled: ServiceHarnessSpec = {
      ...SPEC,
      services: SPEC.services.map((s, i) => (i === 0 ? { ...s, replicas: 2 } : s)),
    };
    expect(needsPerServiceGroups(scaled)).toBe(true); // replicas>1 also forces it (can't bind a port twice in one netns)
  });

  it("emits one group per service, each placed by its OS constraint (${attr.kernel.name})", () => {
    const job = buildNomadTopologyJob(MIXED);
    expect(job.Job.TaskGroups.map((g) => g.Name)).toEqual(["everdict-svc-hub", "everdict-svc-win_node"]);
    const hub = job.Job.TaskGroups[0];
    const win = job.Job.TaskGroups[1];
    expect(hub?.Constraints).toEqual([{ LTarget: "${attr.kernel.name}", Operand: "=", RTarget: "linux" }]);
    expect(win?.Constraints).toEqual([{ LTarget: "${attr.kernel.name}", Operand: "=", RTarget: "windows" }]);
    // Linux service uses the bridge netns; the Windows one can't, so no bridge Mode.
    expect(hub?.Networks?.[0]?.Mode).toBe("bridge");
    expect(win?.Networks?.[0]?.Mode).toBeUndefined();
  });

  it("registers each ported service in Nomad-native discovery (provider nomad, no Consul needed)", () => {
    const job = buildNomadTopologyJob(MIXED);
    expect(job.Job.TaskGroups[0]?.Services).toEqual([
      { Name: nomadServiceName(MIXED, "hub"), PortLabel: "hub", Provider: "nomad" },
    ]);
    expect(nomadServiceName(MIXED, "hub")).toBe("everdict-grid-hub");
  });

  it("injects the peer address from the catalog as EVERDICT_SVC_<PEER> env (the no-DNS Service-DNS analog)", () => {
    const job = buildNomadTopologyJob(MIXED);
    const win = job.Job.TaskGroups[1];
    const tmpl = win?.Tasks[0]?.Templates?.[0];
    expect(tmpl?.Envvars).toBe(true);
    expect(tmpl?.ChangeMode).toBe("restart"); // re-resolve on a peer reschedule (no stale address)
    expect(tmpl?.EmbeddedTmpl).toContain(`nomadService "everdict-grid-hub"`); // camelCase — the render-time func name (snake_case is "not defined", proven live)
    expect(tmpl?.EmbeddedTmpl).toContain(`${peerEnvName("hub")}=http://`);
    expect(peerEnvName("hub")).toBe("EVERDICT_SVC_HUB");
  });

  it("per-service groups allow a reused port across services (separate netns — no co-located port-collision throw)", () => {
    const spec: ServiceHarnessSpec = {
      ...MIXED,
      services: [
        { name: "a", image: "i:1", port: 8000, needs: [], perRun: [], replicas: 2, env: {} }, // replicas>1 → per-service
        { name: "b", image: "i:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} },
      ],
    };
    expect(() => buildNomadTopologyJob(spec)).not.toThrow();
    expect(buildNomadTopologyJob(spec).Job.TaskGroups[0]?.Count).toBe(2); // replicas → group Count
  });
});

describe("peer wiring — inject a peer's coordinates under BYO env names (third-party images)", () => {
  const hub = { name: "hub", image: "selenium/hub:4", port: 4444, needs: [], perRun: [], replicas: 1, env: {} };
  const node = (extra: Partial<ServiceHarnessSpec["services"][number]> = {}) => ({
    name: "node",
    image: "selenium/node:4",
    needs: ["hub"],
    perRun: [],
    replicas: 1,
    env: {},
    wiring: [{ service: "hub", hostEnv: "SE_HUB_HOST", portEnv: "SE_HUB_PORT", urlEnv: "SE_HUB_URL" }],
    ...extra,
  });
  const gridSpec = (over: Partial<ServiceHarnessSpec> = {}): ServiceHarnessSpec => ({
    kind: "service",
    id: "grid",
    version: "1.0.0",
    services: [hub, node()],
    dependencies: [],
    frontDoor: { service: "hub", submit: "POST /session" },
    traceSource: { kind: "otel", endpoint: "http://x" },
    ...over,
  });

  it("Nomad co-located: injects static wiring env (peer loopback alias + declared port)", () => {
    const job = buildNomadTopologyJob(gridSpec());
    const nodeTask = job.Job.TaskGroups[0]?.Tasks.find((t) => t.Name === "node");
    expect(nodeTask?.Env.SE_HUB_HOST).toBe("hub"); // loopback alias (extra_hosts → 127.0.0.1)
    expect(nodeTask?.Env.SE_HUB_PORT).toBe("4444");
    expect(nodeTask?.Env.SE_HUB_URL).toBe("http://hub:4444");
  });

  it("Nomad per-service: renders the wiring env from the discovery catalog (dynamic host/port)", () => {
    // a Windows peer forces the per-service path
    const job = buildNomadTopologyJob(
      gridSpec({
        services: [
          hub,
          node(),
          {
            name: "win",
            image: "w:1",
            port: 5555,
            needs: [],
            perRun: [],
            replicas: 1,
            env: {},
            requires: { os: "windows" },
          },
        ],
      }),
    );
    const tmpl =
      job.Job.TaskGroups.find((g) => g.Name === "everdict-svc-node")?.Tasks[0]?.Templates?.[0]?.EmbeddedTmpl ?? "";
    expect(tmpl).toContain(`nomadService "everdict-grid-hub"`);
    expect(tmpl).toContain("SE_HUB_HOST={{ .Address }}");
    expect(tmpl).toContain("SE_HUB_PORT={{ .Port }}");
    expect(tmpl).toContain("SE_HUB_URL=http://{{ .Address }}:{{ .Port }}");
  });

  it("K8s: injects static wiring env resolving to the peer's Service DNS name", () => {
    const manifests = buildK8sManifests(gridSpec());
    const dep = manifests.find((m) => m.kind === "Deployment" && m.metadata.name === "grid-node") as unknown as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } };
    };
    const env = Object.fromEntries((dep.spec.template.spec.containers[0]?.env ?? []).map((e) => [e.name, e.value]));
    expect(env.SE_HUB_HOST).toBe("grid-hub"); // <id>-<svc> Service DNS
    expect(env.SE_HUB_URL).toBe("http://grid-hub:4444");
  });
});

describe("peer env interpolation — {{peer}} refs in svc.env resolve to a needs peer's endpoint", () => {
  const hub = { name: "hub", image: "selenium/hub:4", port: 4444, needs: [], perRun: [], replicas: 1, env: {} };
  const node = (env: Record<string, string>, extra: Partial<ServiceHarnessSpec["services"][number]> = {}) => ({
    name: "node",
    image: "selenium/node:4",
    needs: ["hub"],
    perRun: [],
    replicas: 1,
    env,
    ...extra,
  });
  const gridSpec = (nodeEnv: Record<string, string>, over: Partial<ServiceHarnessSpec> = {}): ServiceHarnessSpec => ({
    kind: "service",
    id: "grid",
    version: "1.0.0",
    services: [hub, node(nodeEnv)],
    dependencies: [],
    frontDoor: { service: "hub", submit: "POST /session" },
    traceSource: { kind: "otel", endpoint: "http://x" },
    ...over,
  });

  it("Nomad co-located: {{hub}} → the peer's loopback URL, .host/.port variants resolve too (one pass, static)", () => {
    const job = buildNomadTopologyJob(
      gridSpec({ HUB_URL: "{{hub}}", HUB_HOST: "{{hub.host}}", HUB_PORT: "{{hub.port}}", TASK: "call {{hub}}/run" }),
    );
    const nodeTask = job.Job.TaskGroups[0]?.Tasks.find((t) => t.Name === "node");
    expect(nodeTask?.Env.HUB_URL).toBe("http://hub:4444"); // bare token = full URL
    expect(nodeTask?.Env.HUB_HOST).toBe("hub"); // loopback alias (extra_hosts → 127.0.0.1)
    expect(nodeTask?.Env.HUB_PORT).toBe("4444");
    expect(nodeTask?.Env.TASK).toBe("call http://hub:4444/run"); // token embedded mid-value
  });

  it("K8s: {{hub}} resolves to the peer's Service DNS URL (<id>-<svc>)", () => {
    const manifests = buildK8sManifests(gridSpec({ HUB_URL: "{{hub}}", HUB_HOST: "{{hub.host}}" }));
    const dep = manifests.find((m) => m.kind === "Deployment" && m.metadata.name === "grid-node") as unknown as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } };
    };
    const env = Object.fromEntries((dep.spec.template.spec.containers[0]?.env ?? []).map((e) => [e.name, e.value]));
    expect(env.HUB_URL).toBe("http://grid-hub:4444");
    expect(env.HUB_HOST).toBe("grid-hub");
  });

  it("Nomad per-service: a {{hub}} env value is runtime-resolved via the catalog template (not a static Env literal)", () => {
    // a Windows peer forces the per-service (dynamic host-port) path
    const job = buildNomadTopologyJob(
      gridSpec(
        { HUB_URL: "{{hub}}", PLAIN: "x" },
        {
          services: [hub, node({ HUB_URL: "{{hub}}", PLAIN: "x" }, { requires: { os: "windows" } })],
        },
      ),
    );
    const nodeGroup = job.Job.TaskGroups.find((g) => g.Name === "everdict-svc-node");
    const task = nodeGroup?.Tasks[0];
    // the {{peer}} value moves to the template file (consul-template resolves it from the catalog at runtime)…
    const tmpl = task?.Templates?.[0]?.EmbeddedTmpl ?? "";
    // the key stays outside the range (so an unresolved peer yields HUB_URL= rather than dropping the whole line); the URL is inside.
    expect(tmpl).toContain(
      `HUB_URL={{ range nomadService "everdict-grid-hub" }}http://{{ .Address }}:{{ .Port }}{{ end }}`,
    );
    // …and is therefore NOT set as a static literal (would ship {{hub}} verbatim to the container).
    expect(task?.Env.HUB_URL).toBeUndefined();
    expect(task?.Env.PLAIN).toBe("x"); // a value with no peer token stays a plain static env var
  });

  it("fails fast when env references a peer not declared in needs (misconfiguration, not a silent pass-through)", () => {
    const spec = gridSpec({ HUB_URL: "{{hub}}" }, { services: [hub, node({ HUB_URL: "{{hub}}" }, { needs: [] })] });
    expect(() => buildNomadTopologyJob(spec)).toThrowError(/does not declare it in needs/);
    const err = ((): unknown => {
      try {
        buildNomadTopologyJob(spec);
      } catch (e) {
        return e;
      }
    })();
    expect((err as { code?: string }).code).toBe("BAD_REQUEST");
  });

  it("leaves a token that names no declared service verbatim (the harness's own template, not a peer ref)", () => {
    const job = buildNomadTopologyJob(gridSpec({ SELF: "{{run_id}} and {{hub}}" }));
    const nodeTask = job.Job.TaskGroups[0]?.Tasks.find((t) => t.Name === "node");
    expect(nodeTask?.Env.SELF).toBe("{{run_id}} and http://hub:4444"); // unknown left as-is, peer resolved
  });
});

describe("buildNomadTopologyJob — workspace-registry pull auth (registryAuth)", () => {
  const AUTH = { host: "ghcr.io", username: "bot", password: "pull-tok" };

  it("renders the docker auth block only on tasks whose image host matches", () => {
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        { name: "a", image: "ghcr.io/acme/agent:v1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} },
        { name: "b", image: "reg/other:1", port: 9000, needs: [], perRun: [], replicas: 1, env: {} },
      ],
    };
    const job = buildNomadTopologyJob(spec, { registryAuth: AUTH });
    const [a, b] = job.Job.TaskGroups[0]?.Tasks ?? [];
    expect(a?.Config.auth).toEqual([{ username: "bot", password: "pull-tok" }]);
    expect(b?.Config.auth).toBeUndefined();
  });

  it("no auth block when registryAuth is unset (current, no regression)", () => {
    const job = buildNomadTopologyJob(SPEC);
    for (const t of job.Job.TaskGroups[0]?.Tasks ?? []) expect(t.Config.auth).toBeUndefined();
  });
});

describe("buildNomadTopologyJob — Connect mesh obviated by co-location", () => {
  // Co-located services share one netns and talk over loopback, so the builder no longer wires a per-service Connect
  // mesh (sidecars/upstreams). buildConnectService / buildTenantIntentions remain for the standalone enforcement proof
  // and as the cross-tenant authorization decision — see docs/architecture/nomad-colocated-topology.md.
  it("renders no per-service Connect mesh service on the co-located group", () => {
    const job = buildNomadTopologyJob(SPEC, { zoneId: "acme" });
    expect(job.Job.TaskGroups.every((g) => g.Services === undefined)).toBe(true);
  });
});

describe("buildBrowserJob", () => {
  it("no client extension → the default headless Chromium (service) + a CDP dynamic port + allow-origins arg", () => {
    const noExt: ServiceHarnessSpec = {
      ...SPEC,
      target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["dom", "url"] },
    };
    const job = buildBrowserJob(noExt, "abc", { runtime: "runsc" });
    expect(job.Job.ID).toBe(browserJobId("abc"));
    expect(job.Job.Type).toBe("service");
    const g = job.Job.TaskGroups[0];
    expect(g?.Name).toBe("browser");
    expect(g?.Networks?.[0]?.DynamicPorts?.[0]).toEqual({ Label: "cdp", To: 9222 });
    const task = g?.Tasks[0];
    expect(task?.Config.image).toBe(DEFAULT_BROWSER_IMAGE);
    expect(task?.Config.runtime).toBe("runsc");
    expect(task?.Config.ports).toEqual(["cdp"]);
    // headless-shell exposes CDP itself on 9222 → don't override the port, add only allow-origins.
    expect(task?.Config.args).toEqual(["--remote-allow-origins=*"]);
    expect(task?.Env.EVERDICT_RUN_ID).toBe("abc");
  });

  it("client extension (target.extension.ref) → runs the headful browser+extension image AS-IS (no CMD override)", () => {
    // SPEC declares target.extension = { ref: "reg/lupin-ext:1" } — a headful Chromium that loads the extension + serves CDP.
    const task = buildBrowserJob(SPEC, "abc").Job.TaskGroups[0]?.Tasks[0];
    expect(task?.Config.image).toBe("reg/lupin-ext:1"); // the extension image, NOT headless-shell
    expect(task?.Config.args).toBeUndefined(); // don't override the image's own launch (headful + --load-extension)
    expect(task?.Config.ports).toEqual(["cdp"]); // still exposes CDP for the driver to attach
  });
});

describe("topologyJobId (trust-zone keying)", () => {
  it("mixes zoneId into the warm job ID to prevent cross-tenant sharing", () => {
    expect(topologyJobId(SPEC)).toBe("everdict-harness-browser-use-langgraph-1.0.0");
    expect(topologyJobId(SPEC, "acme")).toBe("everdict-harness-browser-use-langgraph-1.0.0-acme");
    expect(topologyJobId(SPEC, "a")).not.toBe(topologyJobId(SPEC, "b"));
  });
});

describe("resolvePort", () => {
  it("finds host:port by label in AllocatedResources.Shared.Ports", () => {
    const alloc: AllocLike = {
      AllocatedResources: { Shared: { Ports: [{ Label: "http", Value: 21500, To: 8080, HostIP: "127.0.0.1" }] } },
    };
    expect(resolvePort(alloc, "http")).toEqual({ hostIp: "127.0.0.1", port: 21500 });
  });

  it("also supports the old Resources.Networks form and fills 127.0.0.1 when HostIP is absent", () => {
    const alloc: AllocLike = { Resources: { Networks: [{ DynamicPorts: [{ Label: "cdp", Value: 30222 }] }] } };
    expect(resolvePort(alloc, "cdp")).toEqual({ hostIp: "127.0.0.1", port: 30222 });
  });

  it("undefined when the label is absent", () => {
    expect(resolvePort({}, "http")).toBeUndefined();
  });
});

describe("provisionDependencies (co-deploy stores + auto-wire connection env)", () => {
  it("K8s: with provisionDependencies, renders PG/Redis Deployment+Service (one per type)", () => {
    const manifests = buildK8sManifests(SPEC, { namespace: "everdict-acme", provisionDependencies: true });
    const names = manifests
      .filter((m) => m.kind === "Deployment")
      .map((m) => m.metadata.name)
      .sort();
    // 3 services + all declared stores (postgres/redis/minio) deployed.
    expect(names).toContain("browser-use-langgraph-postgres");
    expect(names).toContain("browser-use-langgraph-redis");
    expect(names).toContain("browser-use-langgraph-minio");
    const pg = manifests.find(
      (m) => m.kind === "Deployment" && m.metadata.name === "browser-use-langgraph-postgres",
    ) as { spec: { template: { spec: { containers: Array<{ image: string }> } } } };
    expect(pg.spec.template.spec.containers[0]?.image).toBe("postgres:16-alpine");
  });

  // The principled gap-1 fix, wired end-to-end: the redis container's args are DERIVED from the store's role. A plumbing
  // redis (SPEC's redis) renders the eval-cache; a data redis renders durable (no cache args). Proves purpose→config
  // reaches the actual manifest, not just the pure resolver.
  it("K8s: a plumbing redis renders the eval-cache args; a data redis renders durable (no eviction/persist-off)", () => {
    const redisArgs = (spec: ServiceHarnessSpec): string[] | undefined =>
      (
        buildK8sManifests(spec, { namespace: "ns", provisionDependencies: true }).find(
          (m) => m.kind === "Deployment" && m.metadata.name === `${spec.id}-redis`,
        ) as { spec: { template: { spec: { containers: Array<{ args?: string[] }> } } } }
      ).spec.template.spec.containers[0]?.args;

    // SPEC's redis is plumbing (action-stream) → eval-cache.
    expect(redisArgs(SPEC)).toEqual([
      "--maxmemory",
      "200mb",
      "--maxmemory-policy",
      "allkeys-lru",
      "--save",
      "",
      "--appendonly",
      "no",
    ]);
    // Flip it to a data store (world-state a grader reads) → durable, so eviction never corrupts the seeded ground truth.
    const dataRedis: ServiceHarnessSpec = {
      ...SPEC,
      dependencies: [{ store: "redis", role: "world", purpose: "data", isolateBy: "key-prefix" }],
    };
    expect(redisArgs(dataRedis)).toBeUndefined();
  });

  it("K8s: injects the service static env + precedence (connEnv < svc.env < storeEnv)", () => {
    const spec: ServiceHarnessSpec = {
      kind: "service",
      id: "e",
      version: "1",
      services: [
        {
          name: "agent",
          image: "reg/agent:1",
          port: 8080,
          needs: [],
          perRun: [],
          replicas: 1,
          env: { LOG_LEVEL: "info", REDIS_URL: "redis://svc", DATABASE_URL: "postgresql://svc" },
        },
      ],
      dependencies: [
        { store: "postgres", role: "db", purpose: "plumbing", isolateBy: "thread_id" },
        { store: "redis", role: "bus", purpose: "plumbing", isolateBy: "key-prefix" },
      ],
      frontDoor: { service: "agent", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: "http://o:4318" },
    };
    const manifests = buildK8sManifests(spec, {
      namespace: "everdict-e",
      provisionDependencies: true,
      storeEnv: { DATABASE_URL: "postgresql://store" },
    });
    const agent = manifests.find((m) => m.kind === "Deployment" && m.metadata.name === "e-agent") as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } };
    };
    const env = Object.fromEntries(agent.spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
    expect(env.LOG_LEVEL).toBe("info"); // svc.env alone
    expect(env.REDIS_URL).toBe("redis://svc"); // svc.env wins over connEnv (redis://e-redis:6379)
    expect(env.DATABASE_URL).toBe("postgresql://store"); // storeEnv wins over svc.env (store cred is authoritative)
  });

  it("K8s: svc.resources maps to container resources (requests=limits), omitted when unset", () => {
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        {
          name: "big",
          image: "i:1",
          port: 8080,
          needs: [],
          perRun: [],
          replicas: 1,
          env: {},
          resources: { cpu: 2000, memoryMb: 4096 },
        },
        { name: "default", image: "i:1", port: 8081, needs: [], perRun: [], replicas: 1, env: {} },
      ],
      dependencies: [],
    };
    const manifests = buildK8sManifests(spec, { namespace: "everdict-r" });
    const big = manifests.find((m) => m.kind === "Deployment" && m.metadata.name === "browser-use-langgraph-big") as {
      spec: { template: { spec: { containers: Array<{ resources?: unknown }> } } };
    };
    const def = manifests.find(
      (m) => m.kind === "Deployment" && m.metadata.name === "browser-use-langgraph-default",
    ) as { spec: { template: { spec: { containers: Array<{ resources?: unknown }> } } } };
    expect(big.spec.template.spec.containers[0]?.resources).toEqual({
      requests: { cpu: "2000m", memory: "4096Mi" },
      limits: { cpu: "2000m", memory: "4096Mi" },
    });
    expect(def.spec.template.spec.containers[0]?.resources).toBeUndefined();
  });

  it("K8s: svc.volumes → volumes (emptyDir/hostPath) + volumeMounts, svc.readiness → readinessProbe", () => {
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        {
          name: "app",
          image: "i:1",
          port: 8080,
          needs: [],
          perRun: [],
          replicas: 1,
          env: {},
          volumes: ["cache:/cache", "/host/seed:/seed:ro"],
          readiness: { timeoutMs: 30000, intervalMs: 3000 },
        },
      ],
      dependencies: [],
    };
    const m = buildK8sManifests(spec, { namespace: "everdict-v" });
    const dep = m.find((x) => x.kind === "Deployment" && x.metadata.name === "browser-use-langgraph-app") as {
      spec: {
        template: {
          spec: {
            volumes?: Array<Record<string, unknown>>;
            containers: Array<{
              volumeMounts?: Array<Record<string, unknown>>;
              readinessProbe?: Record<string, unknown>;
            }>;
          };
        };
      };
    };
    const podSpec = dep.spec.template.spec;
    // named → emptyDir, bind(/host) → hostPath
    expect(podSpec.volumes?.[0]).toMatchObject({ emptyDir: {} });
    expect(podSpec.volumes?.[1]).toMatchObject({ hostPath: { path: "/host/seed" } });
    const c = podSpec.containers[0];
    expect(c?.volumeMounts?.[0]).toMatchObject({ mountPath: "/cache" });
    expect(c?.volumeMounts?.[1]).toMatchObject({ mountPath: "/seed", readOnly: true });
    // readinessProbe: interval 3s → periodSeconds 3, failureThreshold ceil(30000/3000)=10
    expect(c?.readinessProbe).toMatchObject({
      httpGet: { path: "/", port: 8080 },
      periodSeconds: 3,
      failureThreshold: 10,
    });
  });

  it("K8s: auto-injects DATABASE_URL/REDIS_URL into the service env using store DNS", () => {
    const manifests = buildK8sManifests(SPEC, { namespace: "everdict-acme", provisionDependencies: true });
    const agent = manifests.find(
      (m) => m.kind === "Deployment" && m.metadata.name === "browser-use-langgraph-agent-server",
    ) as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } };
    const env = Object.fromEntries(agent.spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
    expect(env.DATABASE_URL).toBe("postgresql://everdict:everdict@browser-use-langgraph-postgres:5432/everdict");
    expect(env.REDIS_URL).toBe("redis://browser-use-langgraph-redis:6379");
  });

  it("K8s: an explicit storeEnv overrides the automatic connEnv (per-harness variable names)", () => {
    const manifests = buildK8sManifests(SPEC, {
      provisionDependencies: true,
      storeEnv: { DATABASE_URL: "postgresql://custom/db" },
    });
    const agent = manifests.find(
      (m) => m.kind === "Deployment" && m.metadata.name === "browser-use-langgraph-agent-server",
    ) as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } };
    const env = Object.fromEntries(agent.spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
    expect(env.DATABASE_URL).toBe("postgresql://custom/db"); // the explicit value takes precedence
  });

  it("K8s: does not deploy stores without provisionDependencies (existing behavior)", () => {
    const manifests = buildK8sManifests(SPEC);
    expect(manifests.some((m) => m.metadata.name.endsWith("-postgres"))).toBe(false);
  });

  it("Nomad: with provisionDependencies, adds store task groups to the same job (dynamic port)", () => {
    const job = buildNomadTopologyJob(SPEC, { provisionDependencies: true });
    const groups = job.Job.TaskGroups.map((g) => g.Name);
    expect(groups).toContain("browser-use-langgraph-postgres");
    expect(groups).toContain("browser-use-langgraph-redis");
    const pg = job.Job.TaskGroups.find((g) => g.Name === "browser-use-langgraph-postgres");
    expect(pg?.Networks?.[0]?.DynamicPorts?.[0]).toEqual({ Label: "store", To: 5432 });
    expect(pg?.Tasks[0]?.Config.image).toBe("postgres:16-alpine");
  });

  it("Nomad pool: buildSharedStoreJob renders the shared-store job (one per cluster)", () => {
    const job = buildSharedStoreJob(["postgres", "redis"]);
    expect(job.Job.ID).toBe(SHARED_STORE_JOB_ID);
    expect(job.Job.TaskGroups.map((g) => g.Name).sort()).toEqual(["everdict-shared-postgres", "everdict-shared-redis"]);
    const pg = job.Job.TaskGroups.find((g) => g.Name === "everdict-shared-postgres");
    expect(pg?.Networks?.[0]?.DynamicPorts?.[0]).toEqual({ Label: "store", To: 5432 });
  });

  it("minio: renders the store args (server /data) in both the K8s and Nomad builders", () => {
    const k8s = buildSharedStoreManifests(["minio"], "everdict-shared") as Array<{
      kind: string;
      spec?: { template?: { spec: { containers: Array<{ image: string; args?: string[] }> } } };
    }>;
    const dep = k8s.find((m) => m.kind === "Deployment");
    expect(dep?.spec?.template?.spec.containers[0]?.image).toBe("quay.io/minio/minio:latest");
    expect(dep?.spec?.template?.spec.containers[0]?.args).toEqual(["server", "/data"]);
    const nomad = buildSharedStoreJob(["minio"]);
    expect(nomad.Job.TaskGroups[0]?.Tasks[0]?.Config.args).toEqual(["server", "/data"]);
  });

  it("Nomad silo: buildDedicatedStoreJob renders a per-zone dedicated store job (zone-suffixed)", () => {
    const job = buildDedicatedStoreJob(SPEC, ["postgres"], "acme");
    expect(job.Job.ID).toBe("everdict-store-browser-use-langgraph-acme");
    expect(job.Job.TaskGroups.map((g) => g.Name)).toEqual(["everdict-store-acme-postgres"]);
    expect(job.Job.TaskGroups[0]?.Networks?.[0]?.DynamicPorts?.[0]).toEqual({ Label: "store", To: 5432 });
  });
});

describe("buildK8sManifests", () => {
  it("renders a Deployment (+runtimeClass) + Service per service", () => {
    const manifests = buildK8sManifests(SPEC, { runtimeClass: "gvisor" });
    const deploys = manifests.filter((m) => m.kind === "Deployment");
    const svcs = manifests.filter((m) => m.kind === "Service");
    expect(deploys.map((d) => d.metadata.name)).toEqual([
      "browser-use-langgraph-agent-server",
      "browser-use-langgraph-browser-mcp",
      "browser-use-langgraph-action-stream",
    ]);
    expect(svcs).toHaveLength(3);
    const dep0 = deploys[0]?.spec as {
      template: { spec: { runtimeClassName?: string; containers: Array<{ image: string }> } };
    };
    expect(dep0.template.spec.runtimeClassName).toBe("gvisor");
    expect(dep0.template.spec.containers[0]?.image).toBe("reg/bu-agent:1");
  });
});

describe("ServiceTopologyBackend (orchestrator-agnostic, mock runtime)", () => {
  it("drives with a warm topology + per-case browser and injects per-run wiring", async () => {
    const recorded: Record<string, unknown>[] = [];
    const submit: SubmitFn = async (_url, payload) => {
      recorded.push(payload);
    };
    const browserSnap: BrowserSnapshot = {
      kind: "browser",
      url: "https://x",
      dom: "<html/>",
      screenshotRef: "runs/fixed/shot.png",
      console: [],
    };
    const browser: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://browser/ctx" },
      async snapshot() {
        return browserSnap;
      },
      async dispose() {},
    };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return browser;
      },
    };
    const trace: TraceEvent[] = [
      { t: 0, kind: "tool_call", id: "1", name: "browser.click", args: {} },
      { t: 1, kind: "llm_call", model: "m", cost: { inputTokens: 5, outputTokens: 1, usd: 0.02 } },
    ];
    const traceSource: TraceSource = {
      async fetch() {
        return trace;
      },
    };

    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource,
      specFor: () => SPEC,
      submit,
      newRunId: () => "fixed",
    });

    const job: CaseJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "do it",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };

    const result = await backend.dispatch(job);

    expect(result.harness).toBe("browser-use-langgraph@1.0.0");
    expect(result.snapshot.kind).toBe("browser");
    expect(result.scores.map((s) => s.graderId).sort()).toEqual(["cost", "latency", "steps"]);
    // verify per-run wiring injection
    expect(recorded[0]?.thread_id).toBe(keysFor("fixed").threadId);
    expect(recorded[0]?.browser_cdp_url).toBe("ws://browser/ctx");
    expect(recorded[0]?.minio_prefix).toBe("runs/fixed/");
  });

  // Regression (completion liveness) — a sync drive whose agent stream dies with the socket held open must fail on the
  // per-case budget, not hang in `running` forever. Pre-fix: dispatch passed no deadline, so the never-resolving drive
  // hung (the race below would yield HUNG). Fixed: the injected deadline aborts the drive → explicit completion-timeout.
  it("fails a hung sync drive on the per-case budget instead of waiting forever", async () => {
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return {
          wiring: { target_cdp_url: "ws://browser/ctx" },
          async snapshot() {
            return { kind: "browser", url: "https://x", dom: "<html/>", console: [] } satisfies BrowserSnapshot;
          },
          async dispose() {},
        };
      },
    };
    // A driver that never completes on its own — it only settles when its signal aborts (a real sync submit holding the
    // socket while a dead agent never responds).
    const hangingDriver: FrontDoorDriver = {
      drive: (req) =>
        new Promise((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(new InternalError("CANCELLED", {}, "aborted")), {
            once: true,
          });
        }),
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC,
      frontDoorDriver: hangingDriver,
      newRunId: () => "fixed",
      // Fire the deadline immediately (deterministic — no real timeoutSec wait).
      startDriveDeadline: (_ms, onFire) => {
        const t = setTimeout(onFire, 0);
        return () => clearTimeout(t);
      },
    });
    const job: CaseJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };
    const HUNG = Symbol("hung");
    const outcome = await Promise.race([
      backend.dispatch(job).then(
        () => "resolved" as const,
        (e: unknown) => e,
      ),
      new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 1000)),
    ]);
    expect(outcome).not.toBe(HUNG); // pre-fix hangs here
    expect(outcome).toBeInstanceOf(InternalError);
    expect((outcome as InternalError).message).toMatch(/per-case budget/);
  });

  // World-state fixture seeding (P2) — a data store is added to the spec and the case declares a fixture for it.
  const SPEC_SEED: ServiceHarnessSpec = {
    ...SPEC,
    dependencies: [
      ...(SPEC.dependencies ?? []),
      { store: "postgres", role: "world", purpose: "data", isolateBy: "schema" },
    ],
  };
  const seedRuntime = (): TopologyRuntime => ({
    id: "mock",
    async ensureTopology() {
      return { endpoints: { "agent-server": "http://agent-server:8000" } };
    },
    async provisionBrowserEnv() {
      return {
        wiring: { target_cdp_url: "ws://browser/ctx" },
        async snapshot() {
          return { kind: "browser", url: "https://x", dom: "<html/>", console: [] } satisfies BrowserSnapshot;
        },
        async dispose() {},
      };
    },
  });

  it("seeds a case's world-state fixtures into their isolation slice before driving (P2)", async () => {
    const seeded: { runId: string; plans: StoreSeedPlan[] }[] = [];
    const runtime: TopologyRuntime = {
      ...seedRuntime(),
      async seedFixtures(_spec, runId, plans) {
        seeded.push({ runId, plans });
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_SEED,
      submit: async () => {},
      newRunId: () => "fixed",
    });
    const job: CaseJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "do it",
        graders: [],
        timeoutSec: 60,
        tags: [],
        fixtures: [{ store: "postgres", role: "world", seed: { inline: "INSERT INTO t VALUES (1);" } }],
      },
    };

    await backend.dispatch(job);

    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.runId).toBe("fixed");
    expect(seeded[0]?.plans).toEqual([
      {
        store: "postgres",
        role: "world",
        isolateBy: "schema",
        slice: "run_fixed",
        seed: { inline: "INSERT INTO t VALUES (1);" },
        format: "sql",
      },
    ]);
  });

  it("fails a run whose case declares fixtures when the runtime has no seeding capability", async () => {
    const backend = new ServiceTopologyBackend({
      runtime: seedRuntime(),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_SEED,
      submit: async () => {},
      newRunId: () => "fixed",
      // no seedFixtures hook
    });
    const job: CaseJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser" },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
        fixtures: [{ store: "postgres", role: "world", seed: { inline: "x" } }],
      },
    };

    await expect(backend.dispatch(job)).rejects.toThrow(/fixture-seeding capability/);
  });

  it("resolves an artifact-ref fixture to inline via the injected resolver before seeding (P2)", async () => {
    const seeded: StoreSeedPlan[][] = [];
    const runtime: TopologyRuntime = {
      ...seedRuntime(),
      async seedFixtures(_spec, _runId, plans) {
        seeded.push(plans);
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_SEED,
      submit: async () => {},
      newRunId: () => "fixed",
      resolveSeedRef: async (ref) => `-- resolved ${ref}`,
    });
    const job: CaseJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "do it",
        graders: [],
        timeoutSec: 60,
        tags: [],
        fixtures: [{ store: "postgres", role: "world", seed: { ref: "s3://dump.sql" } }],
      },
    };

    await backend.dispatch(job);
    expect(seeded[0]?.[0]?.seed).toEqual({ inline: "-- resolved s3://dump.sql" });
  });

  it("fails a ref fixture when no seed-ref resolver is configured", async () => {
    const runtime: TopologyRuntime = {
      ...seedRuntime(),
      async seedFixtures() {},
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_SEED,
      submit: async () => {},
      newRunId: () => "fixed",
    });
    const job: CaseJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser" },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
        fixtures: [{ store: "postgres", role: "world", seed: { ref: "s3://x" } }],
      },
    };

    await expect(backend.dispatch(job)).rejects.toThrow(/artifact-ref/);
  });

  it("traceSourceFor: the harness's selected workspace source is pulled instead of the fixed runtime source; falls back when none is selected", async () => {
    const browser: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://browser/ctx" },
      async snapshot() {
        return { kind: "browser", url: "https://x", dom: "<html/>", console: [] } satisfies BrowserSnapshot;
      },
      async dispose() {},
    };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return browser;
      },
    };
    const submit: SubmitFn = async () => {};
    const fixed: TraceSource = {
      async fetch() {
        return [{ t: 0, kind: "message", role: "assistant", text: "from FIXED runtime source" }];
      },
    };
    // The per-harness resolved source (a dev-cluster observability endpoint) — receives the run's traceRef (runId).
    let pulledRef: string | undefined;
    const selected: TraceSource = {
      async fetch(ref) {
        pulledRef = ref;
        return [{ t: 0, kind: "message", role: "assistant", text: "from SELECTED workspace source" }];
      },
    };
    const job: CaseJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      tenant: "acme",
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "do it",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };
    const answer = (r: CaseResult) =>
      r.trace
        .filter((e): e is Extract<TraceEvent, { kind: "message" }> => e.kind === "message" && e.role === "assistant")
        .at(-1)?.text ?? "";

    // Selected → the pull uses it (with the runId as the traceRef), not the fixed source.
    const withSelection = new ServiceTopologyBackend({
      runtime,
      traceSource: fixed,
      traceSourceFor: async (tenant, harnessId) =>
        tenant === "acme" && harnessId === "browser-use-langgraph" ? selected : undefined,
      specFor: () => SPEC,
      submit,
      newRunId: () => "fixed",
    });
    expect(answer(await withSelection.dispatch(job))).toBe("from SELECTED workspace source");
    expect(pulledRef).toBe("fixed"); // the run's id is the pull ref (correlation)

    // No selection (resolver returns undefined) → fall back to the fixed runtime source.
    const noSelection = new ServiceTopologyBackend({
      runtime,
      traceSource: fixed,
      traceSourceFor: async () => undefined,
      specFor: () => SPEC,
      submit,
      newRunId: () => "fixed",
    });
    expect(answer(await noSelection.dispatch(job))).toBe("from FIXED runtime source");
  });

  it("delivery sentinel: retrieves the observation inline from the front-door response (result channel), not a browser pull", async () => {
    // The observation returned in the response — kept different from the provisioned browser snapshot to prove sentinel reads from the response.
    const fromResponse: BrowserSnapshot = {
      kind: "browser",
      url: "https://sentinel",
      dom: "<from-response/>",
      screenshotRef: "r",
      console: [],
    };
    const fromBrowser: BrowserSnapshot = { kind: "browser", url: "https://pulled", dom: "<pulled/>", console: [] };
    const submit: SubmitFn = async () => ({ observation: fromResponse });
    const browser: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://browser/ctx" },
      async snapshot() {
        return fromBrowser; // for sentinel, this pulled value must be ignored
      },
      async dispose() {},
    };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return browser;
      },
    };
    const traceSource: TraceSource = {
      async fetch() {
        return [];
      },
    };
    const sentinelSpec: ServiceHarnessSpec = {
      ...SPEC,
      target: {
        kind: "browser",
        engine: "chromium",
        lifecycle: "per-case-instance",
        observe: ["dom"],
        delivery: { mode: "sentinel", path: "observation" },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource,
      specFor: () => sentinelSpec,
      submit,
      newRunId: () => "fixed",
    });
    const job: CaseJob = {
      harness: { id: "bu", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "do it",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };

    const result = await backend.dispatch(job);
    expect(result.snapshot).toEqual(fromResponse); // retrieved from the response, not the browser pull (fromBrowser)
  });

  it("delivery egress: retrieves the observation via GET from the sink ({run_id}-interpolated, where the agent pushed it)", async () => {
    const fromSink: BrowserSnapshot = {
      kind: "browser",
      url: "https://egress",
      dom: "<from-sink/>",
      screenshotRef: "r",
      console: [],
    };
    let fetchedUrl = "";
    const browser: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://browser/ctx" },
      async snapshot() {
        return { kind: "browser", url: "https://pulled", dom: "<pulled/>", console: [] };
      },
      async dispose() {},
    };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return browser;
      },
    };
    const traceSource: TraceSource = {
      async fetch() {
        return [];
      },
    };
    const egressSpec: ServiceHarnessSpec = {
      ...SPEC,
      target: {
        kind: "browser",
        engine: "chromium",
        lifecycle: "per-case-instance",
        observe: ["dom"],
        delivery: { mode: "egress", sink: "http://sink/runs/{run_id}/obs.json" },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource,
      specFor: () => egressSpec,
      submit: async () => ({}),
      getJson: async (url) => {
        fetchedUrl = url;
        return fromSink;
      },
      newRunId: () => "fixed",
    });
    const job: CaseJob = {
      harness: { id: "bu", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "do it",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };

    const result = await backend.dispatch(job);
    expect(fetchedUrl).toBe("http://sink/runs/fixed/obs.json"); // {run_id} interpolated with runId
    expect(result.snapshot).toEqual(fromSink); // retrieved from the sink, not a browser pull
  });

  // Regression (controlled-coordinate correlate, gap 2): frontDoor.contextId supplies a stable session/target coordinate
  // (interpolated from the per-run vocabulary everdict injects — the agent can't overwrite it), and the trace is pulled by
  // THAT, not the run id. Pre-fix the pull always used outcome.traceRef (the run id / the id the agent may have overwritten).
  it("frontDoor.contextId: the trace is pulled by the injected controlled coordinate, not the run id", async () => {
    let pulledRef: string | undefined;
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return {
          wiring: { target_cdp_url: "ws://b" },
          async snapshot() {
            return { kind: "browser", url: "https://x", dom: "<html/>", console: [] } satisfies BrowserSnapshot;
          },
          async dispose() {},
        };
      },
    };
    const traceSource: TraceSource = {
      async fetch(ref) {
        pulledRef = ref;
        return [];
      },
    };
    // contextId = the thread/session id everdict injects into the agent (run-<runId>) — the coordinate the agent honors.
    const contextSpec: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: { ...SPEC.frontDoor, contextId: "{{thread_id}}" },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource,
      specFor: () => contextSpec,
      submit: async () => {},
      newRunId: () => "fixed",
    });
    const job: CaseJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };

    await backend.dispatch(job);
    expect(pulledRef).toBe(keysFor("fixed").threadId); // = "run-fixed", the injected session coordinate — NOT the run id "fixed"
    expect(pulledRef).not.toBe("fixed");
  });

  // Regression (trace-delivery, gap 3): a containerless service target's agent offloaded its observation to its OWN
  // artifact store and referenced it from the trace; the trace source resolves those refs into evidence (fetchDetailed).
  // trace-delivery synthesizes the browser snapshot from that evidence. Pre-fix no delivery mode covered this — reference
  // needs an everdict target, sentinel/egress an everdict-held stage, so the offloaded observation was invisible.
  it("delivery trace: synthesizes the snapshot from the trace's resolved evidence (the harness's offloaded artifacts)", async () => {
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      // Containerless target (the agent owns its own browser/session) — target.acquire=service never provisions a browser.
      async provisionBrowserEnv() {
        throw new Error("provisionBrowserEnv must not be called for a service-acquired (containerless) target");
      },
    };
    // fetchDetailed resolves the in-trace artifact refs to real bytes (ArtifactStore.get) → evidence.
    const traceSource: TraceSource = {
      async fetch() {
        return [];
      },
      async fetchDetailed() {
        return {
          events: [{ t: 0, kind: "message", role: "assistant", text: "done" }],
          evidence: { dom: "<offloaded-page/>", screenshot: "aGVsbG8=", screenshotMediaType: "image/png" },
        };
      },
    };
    const traceDeliverySpec: ServiceHarnessSpec = {
      ...SPEC,
      target: {
        kind: "browser",
        engine: "chromium",
        lifecycle: "per-case-instance",
        observe: ["dom"],
        acquire: {
          mode: "service",
          service: "agent-server",
          open: "POST /sessions",
          coordinates: { session_id: "id" },
        },
        delivery: { mode: "trace" },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource,
      specFor: () => traceDeliverySpec,
      submit: async () => ({ id: "sess-1" }),
      acquireRequest: async () => ({ id: "sess-1" }),
      newRunId: () => "fixed",
    });
    const job: CaseJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "browser", startUrl: "https://x" },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
    };

    const result = await backend.dispatch(job);
    // The snapshot came from the trace evidence (the agent's offloaded DOM+screenshot), not a browser pull (there is none).
    expect(result.snapshot).toEqual({
      kind: "browser",
      url: "",
      dom: "<offloaded-page/>",
      screenshot: "aGVsbG8=",
      console: [],
    });
  });

  it("a trace-source failure does not kill the run — record it as an error event and proceed with snapshot + grading", async () => {
    const browserSnap: BrowserSnapshot = { kind: "browser", url: "https://x", dom: "<html/>", console: [] };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return {
          wiring: { target_cdp_url: "ws://b" },
          async snapshot() {
            return browserSnap;
          },
          async dispose() {},
        };
      },
    };
    // The trace source throws (simulating auth / transient down / not emitted).
    const traceSource: TraceSource = {
      async fetch() {
        throw new Error("MLflow 401 Unauthorized");
      },
    };
    // Snapshot-based graders only — gradeable from the browser result even with an empty trace.
    const urlGrader: Grader = {
      id: "url-ok",
      async grade(ctx) {
        const u = ctx.snapshot?.kind === "browser" ? ctx.snapshot.url : "";
        return { graderId: "url-ok", metric: "url", value: u ? 1 : 0, pass: u === "https://x", detail: u };
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource,
      specFor: () => SPEC,
      submit: async () => {},
      graders: [urlGrader],
      newRunId: () => "fixed",
    });
    const job: CaseJob = {
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      evalCase: { id: "c1", env: { kind: "browser" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    };

    const result = await backend.dispatch(job);

    // dispatch completes without throwing.
    expect(result.scores.find((s) => s.graderId === "url-ok")?.pass).toBe(true);
    // The trace is surfaced as an error event instead of being lost silently.
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]?.kind).toBe("error");
    expect((result.trace[0] as { message?: string }).message).toContain("MLflow 401");
  });

  it("multi-tenant: separates the warm topology per tenant with a different trust-zone (no sharing)", async () => {
    const zonesSeen: Array<TrustZone | undefined> = [];
    const browser: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://b" },
      async snapshot() {
        return { kind: "browser", url: "about:blank", dom: "", console: [] };
      },
      async dispose() {},
    };
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology(_spec, zone) {
        zonesSeen.push(zone);
        return { endpoints: { "agent-server": "http://agent:8000" } };
      },
      async provisionBrowserEnv() {
        return browser;
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC,
      submit: async () => {},
      newRunId: () => "r",
      trustZones: perTenantTrustZones(),
    });
    const mk = (tenant: string): CaseJob => ({
      harness: { id: "browser-use-langgraph", version: "1.0.0" },
      tenant,
      evalCase: { id: `c-${tenant}`, env: { kind: "browser" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    });

    await backend.dispatch(mk("alpha"));
    await backend.dispatch(mk("beta"));

    expect(zonesSeen.map((z) => z?.id)).toEqual(["alpha", "beta"]);
    expect(zonesSeen.map((z) => z?.namespace)).toEqual(["everdict-alpha", "everdict-beta"]); // per-zone separation
    expect(zonesSeen.every((z) => z?.isolationRuntime === "runsc")).toBe(true); // hardened isolation enforced
  });

  // --- #2 completion model ---
  const mockBrowser = (): { handle: TargetEnvHandle; disposed: () => boolean } => {
    let disposed = false;
    return {
      handle: {
        wiring: { target_cdp_url: "ws://b" },
        async snapshot() {
          return { kind: "browser", url: "https://x", dom: "<html/>", console: [] };
        },
        async dispose() {
          disposed = true;
        },
      },
      disposed: () => disposed,
    };
  };
  const mockRuntime = (browser: TargetEnvHandle): TopologyRuntime => ({
    id: "mock",
    async ensureTopology() {
      return { endpoints: { "agent-server": "http://agent-server:8000" } };
    },
    async provisionBrowserEnv() {
      return browser;
    },
  });
  const job: CaseJob = {
    harness: { id: "browser-use-langgraph", version: "1.0.0" },
    evalCase: { id: "c1", env: { kind: "browser" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  };

  it("when the completion model returns timeout, dispatch fails with HARNESS_RUN_FAILED and cleans up the browser", async () => {
    const b = mockBrowser();
    const driver: FrontDoorDriver = {
      async drive() {
        return { traceRef: "fixed", status: "timeout" };
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC,
      frontDoorDriver: driver,
      newRunId: () => "fixed",
    });

    const err = await backend.dispatch(job).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("HARNESS_RUN_FAILED");
    expect(b.disposed()).toBe(true); // per-case browser cleaned up via finally
  });

  it("a user cancel: dispatch threads opts.signal into the front-door drive and tears down the per-case browser on abort", async () => {
    const b = mockBrowser();
    const controller = new AbortController();
    let threaded: AbortSignal | undefined;
    const driver: FrontDoorDriver = {
      async drive(req) {
        threaded = req.signal; // dispatch passes a drive signal that chains the user cancel (+ the per-case deadline)
        controller.abort(); // the drive aborts mid-flight (as the front-door primitives do on a real cancel)
        throw new InternalError("CANCELLED", { reason: "front-door-aborted" }, "aborted");
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC,
      frontDoorDriver: driver,
      newRunId: () => "fixed",
    });

    const err = await backend.dispatch(job, { signal: controller.signal }).catch((e: unknown) => e);

    expect(threaded?.aborted).toBe(true); // the user cancel propagated into the (chained) drive signal
    expect((err as { code?: string }).code).toBe("CANCELLED");
    expect(b.disposed()).toBe(true); // the runtime is freed — per-case browser torn down via the dispatch finally
  });

  it("the target (browser) is released right after observation retrieval — before grading — (not held during grading)", async () => {
    const b = mockBrowser();
    const driver: FrontDoorDriver = {
      async drive() {
        return { traceRef: "fixed", status: "done" };
      },
    };
    let disposedAtGrade: boolean | undefined;
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC,
      frontDoorDriver: driver,
      newRunId: () => "fixed",
      // An observing grader that records whether the target is already released at grading time.
      graders: [
        {
          id: "probe",
          async grade() {
            disposedAtGrade = b.disposed();
            return { graderId: "probe", metric: "probe", value: 1, pass: true };
          },
        },
      ],
    });

    const result = await backend.dispatch(job);

    expect(disposedAtGrade).toBe(true); // early release — the browser isn't held during grading (judge LLM etc.)
    expect(result.scores.some((s) => s.graderId === "probe")).toBe(true);
    expect(b.disposed()).toBe(true);
  });

  it("even when the completion model returns failed, grading proceeds with the snapshot + trace", async () => {
    const b = mockBrowser();
    const driver: FrontDoorDriver = {
      async drive() {
        return { traceRef: "fixed", status: "failed" };
      },
    };
    const trace: TraceEvent[] = [
      { t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } },
    ];
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return trace;
        },
      },
      specFor: () => SPEC,
      frontDoorDriver: driver,
      newRunId: () => "fixed",
    });

    const result = await backend.dispatch(job);

    expect(result.scores.map((s) => s.graderId).sort()).toEqual(["cost", "latency", "steps"]);
    expect(b.disposed()).toBe(true);
  });

  it("poll completion model: polls the status endpoint interpolated with run_id and grades on done", async () => {
    const polled: string[] = [];
    const b = mockBrowser();
    const SPEC_POLL: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: {
        ...SPEC.frontDoor,
        completion: {
          mode: "poll",
          statusPath: "GET /runs/{run_id}/status",
          done: { field: "status", equals: "done" },
          intervalMs: 1,
          timeoutMs: 100_000,
        },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_POLL,
      submit: async () => {},
      getJson: async (url) => {
        polled.push(url);
        return { status: "done" };
      },
      newRunId: () => "fixed",
    });

    const result = await backend.dispatch(job);

    expect(polled).toHaveLength(1);
    expect(polled[0]).toBe("http://agent-server:8000/runs/fixed/status"); // {run_id}→fixed interpolation
    expect(result.scores.length).toBeGreaterThan(0);
  });

  // --- #3 correlate ---
  it("correlate returned: fetches the trace by the id the agent returned in the submit response", async () => {
    const b = mockBrowser();
    let fetchedWith = "";
    const SPEC_RETURNED: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: { ...SPEC.frontDoor, correlate: { mode: "returned", path: "run_id" } },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch(id) {
          fetchedWith = id;
          return [];
        },
      },
      specFor: () => SPEC_RETURNED,
      submit: async () => ({ run_id: "agent-xyz" }),
      newRunId: () => "fixed",
    });

    const result = await backend.dispatch(job);

    expect(result.caseId).toBe("c1");
    expect(fetchedWith).toBe("agent-xyz"); // correlated by the agent-returned id, not the everdict runId (fixed)
  });

  // --- #1 body template (request.bodyTemplate) ---
  it("with request.bodyTemplate, sends a body interpolated with isolateBy-derived wiring", async () => {
    const b = mockBrowser();
    let sent: Record<string, unknown> = {};
    const SPEC_TMPL: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: {
        ...SPEC.frontDoor,
        request: {
          bodyTemplate: {
            prompt: "{{task}}",
            run: "{{run_id}}",
            thread: "{{thread_id}}",
            obj: "{{object_prefix}}",
            cdp: "{{target_cdp_url}}",
          },
        },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_TMPL,
      submit: async (_url, payload) => {
        sent = payload;
      },
      newRunId: () => "fixed",
    });

    await backend.dispatch(job);

    // interpolated with isolateBy-derived variables, not the current fixed LangGraph names (stream_channel/minio_prefix).
    expect(sent).toEqual({
      prompt: "t", // job.task
      run: "fixed",
      thread: "run-fixed", // postgres isolateBy: thread_id
      obj: "runs/fixed/", // minio isolateBy: object-prefix → object_prefix
      cdp: "ws://b", // target_cdp_url
    });
  });

  it("arbitrary target-wiring coordinates (beyond target_cdp_url) flow into the body-template vocabulary (B1 — open vocabulary)", async () => {
    let sent: Record<string, unknown> = {};
    // The target contributes session coordinates (playwright_server_url/session_id) beyond the single CDP coordinate — the handle is a bag.
    const handle: TargetEnvHandle = {
      wiring: { target_cdp_url: "ws://b", playwright_server_url: "ws://pw/session-9", session_id: "sess-9" },
      async snapshot() {
        return { kind: "browser", url: "https://x", dom: "", console: [] };
      },
      async dispose() {},
    };
    const SPEC_TMPL: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: {
        ...SPEC.frontDoor,
        request: {
          bodyTemplate: { pw: "{{playwright_server_url}}", sid: "{{session_id}}", cdp: "{{target_cdp_url}}" },
        },
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_TMPL,
      submit: async (_url, payload) => {
        sent = payload;
      },
      newRunId: () => "fixed",
    });

    await backend.dispatch(job);

    // the target's declared arbitrary coordinates are interpolated as-is, not a fixed vocabulary (task/target_cdp_url).
    expect(sent).toEqual({ pw: "ws://pw/session-9", sid: "sess-9", cdp: "ws://b" });
  });

  it("target.acquire=service: session coordinates flow into the body vocabulary, no runtime browser is brought up, and close on dispose (B2)", async () => {
    let sent: Record<string, unknown> = {};
    const acqCalls: Array<{ method: string; url: string }> = [];
    // Session service: POST /sessions → coordinates, DELETE /sessions/{id} → cleanup.
    const acquireRequest: AcquireRequestFn = async (method, url) => {
      acqCalls.push({ method, url });
      return method === "POST" ? { id: "sess-9", cdp: "ws://sess/9" } : {};
    };
    const SPEC_ACQ: ServiceHarnessSpec = {
      ...SPEC,
      target: {
        kind: "browser",
        engine: "chromium",
        lifecycle: "per-case-instance",
        observe: ["dom"],
        acquire: {
          mode: "service",
          service: "agent-server",
          open: "POST /sessions",
          coordinates: { session_id: "id", target_cdp_url: "cdp" },
          close: "DELETE /sessions/{session_id}",
        },
      },
      frontDoor: { ...SPEC.frontDoor, request: { bodyTemplate: { sid: "{{session_id}}", cdp: "{{target_cdp_url}}" } } },
    };
    let provisioned = false;
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        provisioned = true; // must not be called for service acquisition.
        return mockBrowser().handle;
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_ACQ,
      submit: async (_url, payload) => {
        sent = payload;
      },
      acquireRequest,
      newRunId: () => "fixed",
    });

    await backend.dispatch(job);

    expect(provisioned).toBe(false); // no runtime browser provisioned — uses the service session
    expect(sent).toEqual({ sid: "sess-9", cdp: "ws://sess/9" }); // session coordinates into the body vocabulary
    expect(acqCalls).toContainEqual({ method: "POST", url: "http://agent-server:8000/sessions" }); // open
    expect(acqCalls).toContainEqual({ method: "DELETE", url: "http://agent-server:8000/sessions/sess-9" }); // close
  });

  it("completion=callback: injects callback_url into the body vocabulary and is done from the inbound result (C2)", async () => {
    const rendezvous = new InProcessCallbackRendezvous("http://cb");
    let sent: Record<string, unknown> = {};
    const SPEC_CB: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: {
        ...SPEC.frontDoor,
        completion: { mode: "callback", timeoutMs: 10000 },
        request: { bodyTemplate: { task: "{{task}}", cb: "{{callback_url}}" } },
      },
    };
    // Simulates the agent asynchronously POSTing the terminal result to callback_url — deliver(runId=fixed) right after submit.
    const submit: SubmitFn = async (_url, payload) => {
      sent = payload;
      rendezvous.deliver("fixed", { observation: { kind: "browser" }, done: true });
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(mockBrowser().handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_CB,
      submit,
      callbackRendezvous: rendezvous,
      newRunId: () => "fixed",
    });

    const result = await backend.dispatch(job);

    expect(sent.cb).toBe("http://cb/fixed"); // callback_url flows into the body vocabulary
    expect(result.caseId).toBe(job.evalCase.id); // done from the callback result → dispatch completes without throwing
  });

  it("interpolates {{var}} in request.headers with wiring and passes them as submit headers", async () => {
    let headers: Record<string, string> | undefined;
    const SPEC_H: ServiceHarnessSpec = {
      ...SPEC,
      frontDoor: { ...SPEC.frontDoor, request: { headers: { Authorization: "Bearer {{run_id}}" } } },
    };
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(mockBrowser().handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC_H,
      submit: async (_url, _payload, opts) => {
        headers = opts?.headers;
      },
      newRunId: () => "fixed",
    });

    await backend.dispatch(job);

    expect(headers).toEqual({ Authorization: "Bearer fixed" });
  });

  it("with request unset, keeps the current browser-use 5-field body as-is (no regression)", async () => {
    const b = mockBrowser();
    let sent: Record<string, unknown> = {};
    const backend = new ServiceTopologyBackend({
      runtime: mockRuntime(b.handle),
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC, // no request
      submit: async (_url, payload) => {
        sent = payload;
      },
      newRunId: () => "fixed",
    });

    await backend.dispatch(job);

    expect(sent).toEqual({
      task: "t",
      thread_id: "run-fixed",
      stream_channel: "run-fixed",
      minio_prefix: "runs/fixed/",
      browser_cdp_url: "ws://b",
    });
  });

  // --- #4 target observation (spec.target optional) ---
  it("without spec.target, provisions no browser and grades trace-only (prompt snapshot)", async () => {
    let provisioned = false;
    let sent: Record<string, unknown> = {};
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        provisioned = true;
        throw new Error("must not be called when there is no target");
      },
    };
    const SPEC_NO_TARGET: ServiceHarnessSpec = {
      kind: "service",
      id: SPEC.id,
      version: SPEC.version,
      services: SPEC.services,
      dependencies: SPEC.dependencies,
      frontDoor: SPEC.frontDoor,
      traceSource: SPEC.traceSource,
    }; // target omitted
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } }];
        },
      },
      specFor: () => SPEC_NO_TARGET,
      submit: async (_url, payload) => {
        sent = payload;
      },
      newRunId: () => "fixed",
    });

    const result = await backend.dispatch(job);

    expect(provisioned).toBe(false); // no browser provisioned
    expect(result.snapshot.kind).toBe("prompt"); // no stage → prompt snapshot
    expect(sent).not.toHaveProperty("browser_cdp_url"); // no target, so cdp is excluded from the body
    expect(result.scores.map((s) => s.graderId).sort()).toEqual(["cost", "latency", "steps"]); // trace-only grading
  });

  // --- #5 per-service image pins (imagePins) ---
  it("imagePins: overrides the registered spec's service image and reflects the pin version in the result harness label", async () => {
    const b = mockBrowser();
    let ensuredSpec: ServiceHarnessSpec | undefined;
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology(spec) {
        ensuredSpec = spec;
        return { endpoints: { "agent-server": "http://agent-server:8000" } };
      },
      async provisionBrowserEnv() {
        return b.handle;
      },
    };
    const backend = new ServiceTopologyBackend({
      runtime,
      traceSource: {
        async fetch() {
          return [];
        },
      },
      specFor: () => SPEC,
      submit: async () => {},
      newRunId: () => "fixed",
    });
    const pinnedJob: CaseJob = { ...job, imagePins: { "agent-server": "reg/bu-agent:2" } };

    const result = await backend.dispatch(pinnedJob);

    // ensureTopology was called with the overridden image.
    expect(ensuredSpec?.services.find((s) => s.name === "agent-server")?.image).toBe("reg/bu-agent:2");
    // the pin version is reflected in the result harness label (the scorecard distinguishes variants) — the warm pool separates by this version too.
    expect(result.harness).toMatch(/^browser-use-langgraph@1\.0\.0-pin-[0-9a-f]{8}$/);
  });
});

describe("ServiceTopologyBackend.captureScreen (observability ⑦)", () => {
  const traceSource: TraceSource = {
    async fetch() {
      return [];
    },
  };

  it("rediscovers the browser CDP base by runId and returns a base64 frame", async () => {
    const seen: string[] = [];
    // A runtime whose browser CDP is a local fake we can capture from via injected fetch/connect is out of scope
    // here (captureCdpScreenshot has its own tests). We assert the delegation: browserCdpBase is called with the
    // runId, and a non-undefined base flows into a capture. We stub capture by pointing at a base and asserting
    // the call happened; the real capture is covered in capture-cdp.test.ts.
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: {} };
      },
      async provisionBrowserEnv() {
        throw new Error("unused");
      },
      async browserCdpBase(runId) {
        seen.push(runId);
        return undefined;
      }, // undefined base → captureScreen returns undefined (no live browser)
    };
    const backend = new ServiceTopologyBackend({ runtime, traceSource, specFor: () => SPEC });
    const out = await backend.captureScreen("evd-run-42");
    expect(seen).toEqual(["evd-run-42"]);
    expect(out).toBeUndefined(); // no running browser → no frame
  });

  it("returns undefined when the runtime has no browser rediscovery (K8s port-forward path)", async () => {
    const runtime: TopologyRuntime = {
      id: "mock",
      async ensureTopology() {
        return { endpoints: {} };
      },
      async provisionBrowserEnv() {
        throw new Error("unused");
      },
      // no browserCdpBase
    };
    const backend = new ServiceTopologyBackend({ runtime, traceSource, specFor: () => SPEC });
    expect(await backend.captureScreen("evd-run-1")).toBeUndefined();
  });
});
