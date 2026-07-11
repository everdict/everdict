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

  // self:<runnerId> — personally-owned self-hosted runner routing (Slice 2: ownership check + backend build/routing).
  const selfJob = (target: string, submittedBy?: string): AgentJob => ({
    ...job(target),
    ...(submittedBy ? { submittedBy } : {}),
  });
  const selfDeps = (caps: string[] | undefined) => {
    // caps: undefined = not owned (404), array = owned + that runner's capabilities.
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const stub = { id: "stub", capacity: async () => ({ total: 1, used: 0 }), dispatch: async () => result };
    const resolveSelfRunner = vi.fn(async () => caps);
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
  const poolDeps = (hasRunners: boolean) => {
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const stub = { id: "stub", capacity: async () => ({ total: 1, used: 0 }), dispatch: async () => result };
    const poolHasRunners = vi.fn(async () => hasRunners);
    const buildSelfHostedBackend = vi.fn(() => stub);
    const d = new RuntimeDispatcher({
      inner,
      backends,
      runtimes: new InMemoryRuntimeRegistry(),
      secretsFor: async () => ({}),
      resolveSelfRunner: async () => undefined,
      poolHasRunners,
      buildSelfHostedBackend,
    });
    return { d, seen, backends, poolHasRunners };
  };

  it("self:ws (no id) → route to the workspace pool backend self:ws:acme:* (any runner drains)", async () => {
    const { d, seen, backends, poolHasRunners } = poolDeps(true);
    await d.dispatch(selfJob("self:ws"));
    expect(poolHasRunners).toHaveBeenCalledWith("ws:acme");
    expect(backends.has("self:ws:acme:*")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:ws:acme:*");
  });

  it("self:ws with no runner at all in the workspace → NOT_FOUND", async () => {
    const { d, seen } = poolDeps(false);
    await expect(d.dispatch(selfJob("self:ws"))).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(seen).toHaveLength(0);
  });

  // self (no runner id) — personal pool. owner=submitter (submittedBy). Any of my runners (several processes/machines in one pool).
  it("self (no id) → route to the personal pool backend self:<subject>:* (owner=submitter)", async () => {
    const { d, seen, backends, poolHasRunners } = poolDeps(true);
    await d.dispatch(selfJob("self", "u-alice"));
    expect(poolHasRunners).toHaveBeenCalledWith("u-alice"); // the submitter, not the workspace
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
