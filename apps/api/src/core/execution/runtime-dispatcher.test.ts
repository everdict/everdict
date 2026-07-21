import { BackendRegistry, type Dispatcher } from "@everdict/backends";
import type { AgentJob, CaseResult, RuntimeSpec } from "@everdict/contracts";
import { InMemoryRuntimeRegistry } from "@everdict/registry";
import { describe, expect, it, vi } from "vitest";
import { RuntimeDispatcher } from "./runtime-dispatcher.js";

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};

// inner (Scheduler stand-in) — records the received job and returns result.
function innerSpy() {
  const seen: AgentJob[] = [];
  const inner: Dispatcher = {
    async dispatch(job) {
      seen.push(job);
      return result;
    },
  };
  return { inner, seen };
}

const job = (target?: string): AgentJob => ({
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
    ...(target ? { placement: { target } } : {}),
  },
  harness: { id: "scripted", version: "0" },
  tenant: "acme",
});

const localRuntime: RuntimeSpec = { kind: "local", id: "mylocal", version: "1.0.0", tags: [] };

describe("RuntimeDispatcher", () => {
  it("when placement.target is a tenant Runtime: build/register the backend and rewrite target to rt:tenant:id@ver", async () => {
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const runtimes = new InMemoryRuntimeRegistry();
    await runtimes.register("acme", localRuntime);
    const d = new RuntimeDispatcher({ inner, backends, runtimes, secretsFor: async () => ({}) });

    await d.dispatch(job("mylocal"));
    expect(backends.has("rt:acme:mylocal@1.0.0")).toBe(true); // built + registered
    expect(seen[0]?.evalCase.placement?.target).toBe("rt:acme:mylocal@1.0.0"); // target rewritten

    // A repeat call doesn't rebuild (already registered)
    const built = backends.get("rt:acme:mylocal@1.0.0");
    await d.dispatch(job("mylocal"));
    expect(backends.get("rt:acme:mylocal@1.0.0")).toBe(built);
  });

  it("invalidateTenant drops ONLY that tenant's cached backends — the next dispatch rebuilds with fresh secrets", async () => {
    const { inner } = innerSpy();
    const backends = new BackendRegistry();
    const runtimes = new InMemoryRuntimeRegistry();
    await runtimes.register("acme", localRuntime);
    let secrets: Record<string, string> = {}; // a workspace secret is set between the two dispatches
    const seenEnvs: Array<Record<string, string> | undefined> = [];
    const d = new RuntimeDispatcher({
      inner,
      backends,
      runtimes,
      secretsFor: async () => secrets,
      buildBackend: (_spec, opts) => {
        seenEnvs.push(opts.secretEnv);
        return { capacity: async () => ({ total: 1, used: 0 }), dispatch: async () => result };
      },
    });
    backends.register("rt:other:x@1", { capacity: async () => ({ total: 1, used: 0 }), dispatch: async () => result });

    await d.dispatch(job("mylocal"));
    secrets = { OPENAI_API_KEY: "fresh" };
    await d.dispatch(job("mylocal")); // still the stale cached instance — no rebuild yet
    expect(seenEnvs).toHaveLength(1);

    d.invalidateTenant("acme");
    expect(backends.has("rt:acme:mylocal@1.0.0")).toBe(false);
    expect(backends.has("rt:other:x@1")).toBe(true); // another tenant's backend untouched

    await d.dispatch(job("mylocal"));
    expect(seenEnvs).toHaveLength(2);
    expect(seenEnvs[1]).toEqual({ OPENAI_API_KEY: "fresh" }); // rebuilt with the new secret
  });

  it("when target is already a global backend, pass through unchanged (no runtime resolution)", async () => {
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const runtimes = new InMemoryRuntimeRegistry();
    const resolve = vi.spyOn(runtimes, "get");
    // Assume a global backend "local" already exists (only BackendRegistry.has is consulted)
    backends.register("local", {
      capacity: async () => ({ total: 1, used: 0 }),
      dispatch: async () => result,
    });
    const d = new RuntimeDispatcher({ inner, backends, runtimes, secretsFor: async () => ({}) });
    await d.dispatch(job("local"));
    expect(seen[0]?.evalCase.placement?.target).toBe("local"); // unchanged
    expect(resolve).not.toHaveBeenCalled();
  });

  it("when target is absent, pass through unchanged (default backend policy)", async () => {
    const { inner, seen } = innerSpy();
    const d = new RuntimeDispatcher({
      inner,
      backends: new BackendRegistry(),
      runtimes: new InMemoryRuntimeRegistry(),
      secretsFor: async () => ({}),
    });
    await d.dispatch(job());
    expect(seen[0]?.evalCase.placement?.target).toBeUndefined();
  });

  it("passes the secretsFor result as backend secretEnv (tenant secret injection)", async () => {
    const { inner } = innerSpy();
    const backends = new BackendRegistry();
    const runtimes = new InMemoryRuntimeRegistry();
    await runtimes.register("acme", localRuntime);
    const secretsFor = vi.fn(async () => ({ ANTHROPIC_API_KEY: "sk" }));
    const d = new RuntimeDispatcher({ inner, backends, runtimes, secretsFor });
    await d.dispatch(job("mylocal"));
    expect(secretsFor).toHaveBeenCalledWith("acme");
  });

  // Capability placement gate — reject a job the registered runtime can't run BEFORE dispatching (else the
  // orchestrator accepts it and the mismatched service sits pending forever). See heterogeneous-topology-placement.md.
  const winSvcJob = (target: string): AgentJob => ({
    ...job(target),
    harnessSpec: {
      kind: "service",
      id: "grid",
      version: "1",
      services: [
        { name: "hub", image: "h:1", port: 4444, needs: [], perRun: [], replicas: 1, env: {} },
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
      dependencies: [],
      frontDoor: { service: "hub", submit: "POST /s" },
      traceSource: { kind: "otel", endpoint: "http://x" },
    },
  });
  const nomad = (capabilities?: string[]): RuntimeSpec => ({
    kind: "nomad",
    id: "cluster",
    version: "1.0.0",
    addr: "http://nomad:4646",
    image: "agent:1",
    tags: [],
    ...(capabilities ? { capabilities: capabilities as RuntimeSpec["capabilities"] } : {}),
  });
  const gateSetup = async (spec: RuntimeSpec) => {
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const runtimes = new InMemoryRuntimeRegistry();
    await runtimes.register("acme", spec);
    const stub = { capacity: async () => ({ total: 1, used: 0 }), dispatch: async () => result };
    const d = new RuntimeDispatcher({
      inner,
      backends,
      runtimes,
      secretsFor: async () => ({}),
      buildBackend: () => stub,
    });
    return { d, seen };
  };

  it("rejects a Windows-service topology on a runtime that doesn't advertise os-windows (before dispatch)", async () => {
    const { d, seen } = await gateSetup(nomad(["docker"])); // labeled, but no os-windows
    await expect(d.dispatch(winSvcJob("cluster"))).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
    expect(seen).toHaveLength(0); // never reaches the scheduler / the orchestrator
  });

  it("routes when the runtime advertises os-windows", async () => {
    const { d, seen } = await gateSetup(nomad(["docker", "os-windows"]));
    await d.dispatch(winSvcJob("cluster"));
    expect(seen).toHaveLength(1);
  });

  it("backward-compat: a runtime that declares NO capabilities is not gated (passes as before)", async () => {
    const { d, seen } = await gateSetup(nomad()); // capabilities undefined
    await d.dispatch(winSvcJob("cluster"));
    expect(seen).toHaveLength(1);
  });

  // self:<runnerId> — personally-owned self-hosted runner routing (Slice 2: ownership check + backend build/routing).
  const selfJob = (target: string, submittedBy?: string): AgentJob => ({
    ...job(target),
    ...(submittedBy ? { submittedBy } : {}),
  });
  const selfDeps = (caps: string[] | undefined, online = true) => {
    // caps: undefined = not owned (404), array = owned + that runner's capabilities. online = reachable right now.
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const stub = { id: "stub", capacity: async () => ({ total: 1, used: 0 }), dispatch: async () => result };
    const resolveSelfRunner = vi.fn(async () =>
      caps === undefined ? undefined : { capabilities: caps, online, label: "dev-laptop" },
    );
    const buildSelfHostedBackend = vi.fn(() => stub);
    const d = new RuntimeDispatcher({
      inner,
      backends,
      runtimes: new InMemoryRuntimeRegistry(),
      secretsFor: async () => ({}),
      resolveSelfRunner,
      buildSelfHostedBackend,
    });
    return { d, seen, backends, resolveSelfRunner, buildSelfHostedBackend };
  };

  // A service-harness job (harnessSpec.kind==="service") — for verifying the docker capability gate.
  const selfServiceJob = (target: string, submittedBy: string): AgentJob => ({
    ...selfJob(target, submittedBy),
    harnessSpec: {
      kind: "service",
      id: "bu",
      version: "1",
      services: [],
      dependencies: [],
      frontDoor: { service: "s", submit: "POST /runs" },
      traceSource: { kind: "mlflow", endpoint: "http://x" },
    },
  });

  it("self:<runnerId> owned by the submitter: build/register the self:owner:runnerId backend and route there", async () => {
    const { d, seen, backends, resolveSelfRunner } = selfDeps(["repo"]);
    await d.dispatch(selfJob("self:dev-laptop", "u-alice"));
    expect(resolveSelfRunner).toHaveBeenCalledWith("u-alice", "dev-laptop");
    expect(backends.has("self:u-alice:dev-laptop")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:u-alice:dev-laptop");
  });

  it("self: runner not owned → NOT_FOUND (reject targeting someone else's runner — no existence leak)", async () => {
    const { d, seen } = selfDeps(undefined);
    await expect(d.dispatch(selfJob("self:someone-else", "u-alice"))).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(seen).toHaveLength(0); // doesn't reach inner
  });

  it("self: with an unknown submittedBy (owner) → NOT_FOUND", async () => {
    const { d } = selfDeps(["repo"]);
    await expect(d.dispatch(selfJob("self:dev-laptop"))).rejects.toMatchObject({ status: 404 });
  });

  it("service harness but the runner lacks the docker capability → BAD_REQUEST (blocked before running)", async () => {
    const { d, seen } = selfDeps(["repo"]); // no docker
    await expect(d.dispatch(selfServiceJob("self:dev-laptop", "u-alice"))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
    expect(seen).toHaveLength(0); // blocked before running — doesn't reach inner
  });

  it("service harness + docker capability present → routed", async () => {
    const { d, seen, backends } = selfDeps(["repo", "docker", "browser"]);
    await d.dispatch(selfServiceJob("self:dev-laptop", "u-alice"));
    expect(backends.has("self:u-alice:dev-laptop")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:u-alice:dev-laptop");
  });

  // Immediate offline-runner feedback (Phase 1): a pinned runner that's OFFLINE right now doesn't hard-fail (it may
  // reconnect within the idle window) — the job still parks, but onWaiting surfaces the reason at dispatch time
  // instead of the case sitting silently "queued" for ~5 minutes.
  it("pinned runner offline → fires onWaiting with an actionable reason AND still parks (non-terminal)", async () => {
    const { d, seen } = selfDeps(["repo"], false); // owned + capable, but offline
    const onWaiting = vi.fn();
    await d.dispatch(selfJob("self:dev-laptop", "u-alice"), { onWaiting });
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting.mock.calls[0]?.[0]).toMatch(/offline/i);
    expect(onWaiting.mock.calls[0]?.[0]).toContain("dev-laptop"); // names the runner
    expect(seen).toHaveLength(1); // still routed/parked — it runs the moment the runner reconnects
  });

  it("pinned runner online → does NOT fire onWaiting (healthy dispatch)", async () => {
    const { d } = selfDeps(["repo"], true);
    const onWaiting = vi.fn();
    await d.dispatch(selfJob("self:dev-laptop", "u-alice"), { onWaiting });
    expect(onWaiting).not.toHaveBeenCalled();
  });

  // self:ws:<runnerId> — a workspace-shared runner. The owner is derived from the job's tenant (ws:<tenant>), not the submitter, so
  // any member of that workspace can target it (regardless of submittedBy). For sharing team build servers/CI runners.
  it("self:ws:<runnerId> resolves as owner=ws:<tenant> (any member — no submittedBy needed)", async () => {
    const { d, seen, backends, resolveSelfRunner } = selfDeps(["git", "docker"]);
    await d.dispatch(selfJob("self:ws:team-builder")); // no submittedBy
    expect(resolveSelfRunner).toHaveBeenCalledWith("ws:acme", "team-builder");
    expect(backends.has("self:ws:acme:team-builder")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:ws:acme:team-builder");
  });

  it("self:ws: with no shared runner in that workspace → NOT_FOUND (cross-workspace blocked)", async () => {
    const { d, seen, resolveSelfRunner } = selfDeps(undefined);
    await expect(d.dispatch(selfJob("self:ws:nope"))).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(resolveSelfRunner).toHaveBeenCalledWith("ws:acme", "nope"); // always looked up by the job's tenant only — can't see another ws
    expect(seen).toHaveLength(0);
  });

  // self:ws (no runner id) — workspace pool. Instead of a specific runner, any runner of that workspace (satisfying the capabilities) takes it.
  const poolDeps = (hasRunners: boolean, fleets?: string[][], online = true) => {
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const stub = { id: "stub", capacity: async () => ({ total: 1, used: 0 }), dispatch: async () => result };
    // hasRunners=false → empty pool (404). Else one runner per fleet (default: a single no-capability runner), each
    // carrying `online`. poolRunners subsumes the old poolHasRunners (empty = none) + poolRunnerCapabilities (caps).
    const runners = hasRunners
      ? (fleets ?? [[]]).map((caps, i) => ({ capabilities: caps, online, label: `r${i}` }))
      : [];
    const poolRunners = vi.fn(async () => runners);
    const buildSelfHostedBackend = vi.fn(() => stub);
    const d = new RuntimeDispatcher({
      inner,
      backends,
      runtimes: new InMemoryRuntimeRegistry(),
      secretsFor: async () => ({}),
      resolveSelfRunner: async () => undefined,
      poolRunners,
      buildSelfHostedBackend,
    });
    return { d, seen, backends, poolRunners };
  };

  it("self:ws (no id) → route to the workspace pool backend self:ws:acme:* (any runner drains)", async () => {
    const { d, seen, backends, poolRunners } = poolDeps(true);
    await d.dispatch(selfJob("self:ws"));
    expect(poolRunners).toHaveBeenCalledWith("ws:acme");
    expect(backends.has("self:ws:acme:*")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:ws:acme:*");
  });

  it("self:ws with no runner at all in the workspace → NOT_FOUND", async () => {
    const { d, seen } = poolDeps(false);
    await expect(d.dispatch(selfJob("self:ws"))).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(seen).toHaveLength(0);
  });

  it("a pool job NO runner can satisfy fails fast at dispatch naming the missing capability", async () => {
    // Regression: the lease-time gate only SKIPS per runner, so a job requiring a capability no pool runner
    // advertises (a windows-service topology on a Linux-only fleet) parked unleased until the generic idle
    // timeout — nothing ever named os-windows. The dispatch-time satisfiability gate rejects it immediately.
    const { d, seen } = poolDeps(true, [
      ["git", "docker", "browser"],
      ["git", "docker"],
    ]);
    const winJob: AgentJob = {
      ...selfServiceJob("self:ws", "u-alice"),
      harnessSpec: {
        kind: "service",
        id: "bu",
        version: "1",
        services: [
          { name: "client", image: "i", needs: [], perRun: [], replicas: 1, env: {}, requires: { os: "windows" } },
        ],
        dependencies: [],
        frontDoor: { service: "client", submit: "POST /runs" },
        traceSource: { kind: "mlflow", endpoint: "http://x" },
      },
    };
    await expect(d.dispatch(winJob)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
    await expect(d.dispatch(winJob)).rejects.toThrow(/os-windows/);
    expect(seen).toHaveLength(0);
  });

  it("a pool job SOME runner can satisfy passes the satisfiability gate and routes to the pool", async () => {
    const { d, seen } = poolDeps(true, [["git"], ["git", "docker", "browser", "topology", "os-windows"]]);
    const winJob: AgentJob = {
      ...selfServiceJob("self:ws", "u-alice"),
      harnessSpec: {
        kind: "service",
        id: "bu",
        version: "1",
        services: [
          { name: "client", image: "i", needs: [], perRun: [], replicas: 1, env: {}, requires: { os: "windows" } },
        ],
        dependencies: [],
        frontDoor: { service: "client", submit: "POST /runs" },
        traceSource: { kind: "mlflow", endpoint: "http://x" },
      },
    };
    await d.dispatch(winJob);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:ws:acme:*");
  });

  // Immediate offline-runner feedback (Phase 1) — pool variant: capable runner(s) exist but ALL are offline right now.
  it("pool with capable runners but ALL offline → fires onWaiting AND still parks (non-terminal)", async () => {
    const { d, seen } = poolDeps(true, [["git", "docker"]], false); // one capable runner, offline
    const onWaiting = vi.fn();
    await d.dispatch(selfJob("self:ws"), { onWaiting });
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting.mock.calls[0]?.[0]).toMatch(/offline/i);
    expect(seen).toHaveLength(1); // still routed to the pool backend — runs when a runner reconnects
  });

  it("pool with an online capable runner → does NOT fire onWaiting (a runner can pick it up)", async () => {
    const { d } = poolDeps(true, [["git", "docker"]], true);
    const onWaiting = vi.fn();
    await d.dispatch(selfJob("self:ws"), { onWaiting });
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it("pool where NO runner is capable → still the hard 400 (never onWaiting — it can never succeed)", async () => {
    // Offline is a soft warning (reconnect fixes it); an uncapable pool is a hard failure (nothing can ever run it).
    const { d, seen } = poolDeps(true, [["git"]], false); // offline AND lacks docker
    const onWaiting = vi.fn();
    await expect(d.dispatch(selfServiceJob("self:ws", "u-alice"), { onWaiting })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
    expect(onWaiting).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  // self (no runner id) — personal pool. owner=submitter (submittedBy). Any of my runners (several processes/machines in one pool).
  it("self (no id) → route to the personal pool backend self:<subject>:* (owner=submitter)", async () => {
    const { d, seen, backends, poolRunners } = poolDeps(true);
    await d.dispatch(selfJob("self", "u-alice"));
    expect(poolRunners).toHaveBeenCalledWith("u-alice"); // the submitter, not the workspace
    expect(backends.has("self:u-alice:*")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:u-alice:*");
  });

  it("self with an unknown submitter (submittedBy) → NOT_FOUND (the personal pool requires auth)", async () => {
    const { d, seen } = poolDeps(true);
    await expect(d.dispatch(selfJob("self"))).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(seen).toHaveLength(0);
  });

  it("self with no runner of my own at all → NOT_FOUND", async () => {
    const { d, seen } = poolDeps(false);
    await expect(d.dispatch(selfJob("self", "u-alice"))).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(seen).toHaveLength(0);
  });
});
