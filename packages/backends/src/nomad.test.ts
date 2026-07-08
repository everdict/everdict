import { RESULT_SENTINEL } from "@everdict/agent";
import { type AgentJob, BadRequestError, type CaseResult } from "@everdict/core";
import { describe, expect, it, vi } from "vitest";
import { NomadBackend, type NomadHttp, buildNomadJob, fetchHttp } from "./nomad.js";
import { staticSecrets } from "./secrets.js";
import { perTenantTrustZones, staticTrustZones } from "./trust-zone.js";

const JOB: AgentJob = {
  harness: { id: "claude-code", version: "latest" },
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [{ id: "steps" }],
    timeoutSec: 60,
    tags: [],
  },
};

const RESULT: CaseResult = {
  caseId: "c1",
  harness: "claude-code@latest",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "abc" },
  scores: [{ graderId: "steps", metric: "tool_calls", value: 0 }],
};

describe("buildNomadJob", () => {
  it("puts the image, isolation runtime, secrets, and job payload into the task spec", () => {
    const spec = buildNomadJob(JOB, {
      addr: "http://nomad:4646",
      image: "reg/everdict-agent:1",
      secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      runtime: "runsc",
    });
    const task = spec.Job.TaskGroups[0]?.Tasks[0];
    expect(task?.Config.image).toBe("reg/everdict-agent:1");
    expect(task?.Config.runtime).toBe("runsc");
    expect(task?.Env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    const decoded = JSON.parse(Buffer.from(task?.Env.EVERDICT_AGENT_JOB ?? "", "base64").toString("utf8"));
    expect(decoded.evalCase.id).toBe("c1");
    expect(decoded.harness.id).toBe("claude-code");
  });

  it("renders a docker auth block when case.image is a workspace-registry one (job.registryAuth)", () => {
    const withAuth: AgentJob = {
      ...JOB,
      evalCase: { ...JOB.evalCase, image: "ghcr.io/acme/sbench:v1" },
      registryAuth: { host: "ghcr.io", username: "bot", password: "pull-tok" },
    };
    const spec = buildNomadJob(withAuth, { addr: "http://nomad:4646", image: "reg/everdict-agent:1" });
    expect(spec.Job.TaskGroups[0]?.Tasks[0]?.Config.auth).toEqual([{ username: "bot", password: "pull-tok" }]);
    // On a host mismatch (e.g. the default agent image), auth isn't rendered — don't send credentials to an unrelated registry.
    const mismatch = buildNomadJob(
      { ...JOB, registryAuth: { host: "ghcr.io", password: "p" } },
      { addr: "http://nomad:4646", image: "reg/everdict-agent:1" },
    );
    expect(mismatch.Job.TaskGroups[0]?.Tasks[0]?.Config.auth).toBeUndefined();
  });

  it("with job.judge, injects the judge model env into the alloc (keys via secretEnv)", () => {
    const spec = buildNomadJob(
      { ...JOB, judge: { provider: "openai", model: "gpt-5.4-mini" } },
      {
        addr: "http://nomad:4646",
        image: "reg/everdict-agent:1",
        secretEnv: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "http://litellm" },
      },
    );
    const env = spec.Job.TaskGroups[0]?.Tasks[0]?.Env;
    expect(env?.EVERDICT_JUDGE_MODEL).toBe("gpt-5.4-mini"); // per-run config
    expect(env?.EVERDICT_JUDGE_PROVIDER).toBe("openai");
    expect(env?.OPENAI_API_KEY).toBe("k"); // the provider key is a tenant secret
    expect(env?.OPENAI_BASE_URL).toBe("http://litellm");
  });
  it("with no job.judge, doesn't add judge env", () => {
    const spec = buildNomadJob(JOB, { addr: "http://nomad:4646", image: "i" });
    expect(spec.Job.TaskGroups[0]?.Tasks[0]?.Env.EVERDICT_JUDGE_MODEL).toBeUndefined();
  });
  it("with evalCase.image, override with the per-case image (e.g. SWE-bench prebuilt)", () => {
    const withImage = { ...JOB, evalCase: { ...JOB.evalCase, image: "swebench/sweb.eval.x86_64.x_1776_y-1:latest" } };
    const on = buildNomadJob(withImage, { addr: "http://nomad:4646", image: "reg/agent:1" });
    expect(on.Job.TaskGroups[0]?.Tasks[0]?.Config.image).toBe("swebench/sweb.eval.x86_64.x_1776_y-1:latest");
    const off = buildNomadJob(JOB, { addr: "http://nomad:4646", image: "reg/agent:1" });
    expect(off.Job.TaskGroups[0]?.Tasks[0]?.Config.image).toBe("reg/agent:1"); // default when absent
  });
});

describe("fetchHttp (Nomad API auth)", () => {
  it("attaches the X-Nomad-Token header when apiToken is present", async () => {
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) => Promise.resolve(new Response("{}", { status: 200 })));
    const http = fetchHttp("http://nomad:4646", "secret-acl-token", fetchImpl as typeof fetch);
    await http.request("GET", "/v1/jobs");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://nomad:4646/v1/jobs");
    expect((init.headers as Record<string, string>)["x-nomad-token"]).toBe("secret-acl-token");
  });

  it("doesn't attach X-Nomad-Token when apiToken is absent", async () => {
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) => Promise.resolve(new Response("{}", { status: 200 })));
    const http = fetchHttp("http://nomad:4646", undefined, fetchImpl as typeof fetch);
    await http.request("GET", "/v1/jobs");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.["x-nomad-token"]).toBeUndefined();
  });
});

describe("NomadBackend.dispatch", () => {
  it("submit job → poll alloc completion → parse CaseResult from the stdout sentinel", async () => {
    const calls: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        calls.push(`${method} ${path}`);
        if (path === "/v1/jobs") return { status: 200, text: "{}" };
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "alloc1", ClientStatus: "complete" }]) };
        if (path.includes("/logs/"))
          return { status: 200, text: `prelude line\n${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n` };
        return { status: 404, text: "" };
      },
    };
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      pollIntervalMs: 1,
      purgeDeadJobs: true,
      purgeDelayMs: 0,
    });

    const result = await backend.dispatch(JOB);

    expect(result.caseId).toBe("c1");
    expect(result.harness).toBe("claude-code@latest");
    expect(calls.some((c) => c === "POST /v1/jobs")).toBe(true);
    expect(calls.some((c) => c.includes("/allocations"))).toBe(true);
    expect(calls.some((c) => c.includes("/logs/alloc1"))).toBe(true);
    // Dead-job purge after capturing the result — without it batch churn crosses the client's gc_max_allocs and
    // later cases lose the alloc-log race (the whole batch reads as dispatch failures).
    expect(calls.some((c) => c.startsWith("DELETE /v1/job/everdict-c1") && c.includes("purge=true"))).toBe(true);
  });

  it("purges the dead job even when the log fetch fails (finally path)", async () => {
    const calls: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        calls.push(`${method} ${path}`);
        if (path === "/v1/jobs") return { status: 200, text: "{}" };
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "alloc1", ClientStatus: "complete" }]) };
        if (path.includes("/logs/")) return { status: 404, text: "" }; // alloc dir already GC'd
        return { status: 200, text: "{}" };
      },
    };
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      pollIntervalMs: 1,
      purgeDeadJobs: true,
      purgeDelayMs: 0,
    });
    await expect(backend.dispatch(JOB)).rejects.toThrow(/gc_max_allocs/); // actionable error, not a bare 404
    expect(calls.some((c) => c.startsWith("DELETE /v1/job/everdict-c1") && c.includes("purge=true"))).toBe(true);
  });

  it("purge is OFF by default — no DELETE is ever sent (dev-mode agents panic on purge-during-churn)", async () => {
    const calls: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        calls.push(`${method} ${path}`);
        if (path === "/v1/jobs") return { status: 200, text: "{}" };
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "alloc1", ClientStatus: "complete" }]) };
        if (path.includes("/logs/")) return { status: 200, text: `${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n` };
        return { status: 200, text: "{}" };
      },
    };
    const backend = new NomadBackend({ addr: "http://nomad:4646", image: "img", http, pollIntervalMs: 1 });
    await backend.dispatch(JOB);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("purge is DEFERRED — a just-finished job is left alone (fresh-terminal alloc watcher race), swept by a later dispatch", async () => {
    const calls: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        calls.push(`${method} ${path}`);
        if (path === "/v1/jobs") return { status: 200, text: "{}" };
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "alloc1", ClientStatus: "complete" }]) };
        if (path.includes("/logs/")) return { status: 200, text: `${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n` };
        return { status: 200, text: "{}" };
      },
    };
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      pollIntervalMs: 1,
      purgeDeadJobs: true,
      purgeDelayMs: 50,
    });
    await backend.dispatch(JOB);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false); // own job too fresh to purge
    await new Promise((r) => setTimeout(r, 60));
    await backend.dispatch(JOB); // the next dispatch sweeps the aged entry
    expect(calls.filter((c) => c.startsWith("DELETE /v1/job/everdict-c1"))).toHaveLength(1);
  });

  it("trustZones: applies the tenant zone per job (namespace + strong-isolation runtime)", async () => {
    let posted: {
      Job?: { Namespace?: string; TaskGroups?: Array<{ Tasks: Array<{ Config: { runtime?: string } }> }> };
    } = {};
    const http: NomadHttp = {
      async request(method, path, body) {
        if (method === "POST" && path.startsWith("/v1/jobs")) {
          posted = body as typeof posted;
          return { status: 200, text: "{}" };
        }
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "a1", ClientStatus: "complete" }]) };
        if (path.includes("/logs/")) return { status: 200, text: `${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n` };
        return { status: 404, text: "" };
      },
    };
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      pollIntervalMs: 1,
      trustZones: perTenantTrustZones(),
    });

    await backend.dispatch({ ...JOB, tenant: "acme" });

    expect(posted.Job?.Namespace).toBe("everdict-acme");
    expect(posted.Job?.TaskGroups?.[0]?.Tasks[0]?.Config.runtime).toBe("runsc");
  });

  it("trustZones: forcing runc on an untrusted tenant refuses the dispatch", async () => {
    const http: NomadHttp = {
      async request() {
        return { status: 200, text: "{}" };
      },
    };
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      trustZones: staticTrustZones({}, { id: "weak", isolationRuntime: "runc", network: "open", trusted: false }),
    });
    await expect(backend.dispatch({ ...JOB, tenant: "x" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("secrets: injects only that tenant's keys into the alloc env per job (no leakage)", async () => {
    const posted: Array<Record<string, string>> = [];
    const http: NomadHttp = {
      async request(method, path, body) {
        if (method === "POST" && path.startsWith("/v1/jobs")) {
          const env = (body as { Job: { TaskGroups: Array<{ Tasks: Array<{ Env: Record<string, string> }> }> } }).Job
            .TaskGroups[0]?.Tasks[0]?.Env;
          posted.push(env ?? {});
          return { status: 200, text: "{}" };
        }
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "a1", ClientStatus: "complete" }]) };
        if (path.includes("/logs/")) return { status: 200, text: `${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n` };
        return { status: 404, text: "" };
      },
    };
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      pollIntervalMs: 1,
      secrets: staticSecrets({ acme: { ANTHROPIC_API_KEY: "sk-acme" }, globex: { ANTHROPIC_API_KEY: "sk-globex" } }),
    });

    await backend.dispatch({ ...JOB, tenant: "acme" });
    await backend.dispatch({ ...JOB, tenant: "globex" });

    expect(posted[0]?.ANTHROPIC_API_KEY).toBe("sk-acme");
    expect(posted[1]?.ANTHROPIC_API_KEY).toBe("sk-globex"); // acme's key doesn't leak into globex's job
  });
});

describe("NomadBackend.probe", () => {
  it("with /v1/agent/self 200, reachable + member name", async () => {
    const http: NomadHttp = {
      async request(_m, path) {
        if (path === "/v1/agent/self") return { status: 200, text: JSON.stringify({ member: { Name: "nomad-1" } }) };
        return { status: 404, text: "" };
      },
    };
    const backend = new NomadBackend({ addr: "http://nomad:4646", image: "img", http });
    expect(await backend.probe()).toEqual({ reachable: true, detail: "Nomad agent: nomad-1" });
  });

  it("with 401/403 (ACL), unreachable + auth guidance", async () => {
    const http: NomadHttp = {
      async request() {
        return { status: 403, text: "Permission denied" };
      },
    };
    const backend = new NomadBackend({ addr: "http://nomad:4646", image: "img", http });
    const r = await backend.probe();
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("auth failed (403)");
  });

  it("with a network error, unreachable + message", async () => {
    const http: NomadHttp = {
      async request() {
        throw new Error("ECONNREFUSED");
      },
    };
    const backend = new NomadBackend({ addr: "http://nomad:4646", image: "img", http });
    const r = await backend.probe();
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("ECONNREFUSED");
  });
});
