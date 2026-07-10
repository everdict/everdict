import { EventEmitter } from "node:events";
import { RESULT_SENTINEL } from "@everdict/contracts";
import { type AgentJob, BadRequestError, type CaseResult } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { staticSecrets } from "../policy/secrets.js";
import { perTenantTrustZones, staticTrustZones } from "../policy/trust-zone.js";
import { NomadBackend, type NomadHttp, type StreamChild, buildNomadJob, fetchHttp, streamHandleFor } from "./nomad.js";

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

describe("NomadBackend.adopt / kill (boot-recovery adoption + supersede force-stop)", () => {
  it("adopt finds the NEWEST everdict-<caseId>-* job, waits for its alloc, and harvests the sentinel result", async () => {
    const calls: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        calls.push(`${method} ${path}`);
        if (path.startsWith("/v1/jobs?prefix="))
          return {
            status: 200,
            text: JSON.stringify([
              { ID: "everdict-c1-old01", Namespace: "default", SubmitTime: 100 },
              { ID: "everdict-c1-new02", Namespace: "default", SubmitTime: 200 },
            ]),
          };
        if (path.includes("everdict-c1-new02/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "alloc9", ClientStatus: "complete" }]) };
        if (path.includes("/logs/alloc9"))
          return { status: 200, text: `x\n${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n` };
        return { status: 404, text: "" };
      },
    };
    const backend = new NomadBackend({ addr: "http://n:4646", image: "img", http, pollIntervalMs: 1 });

    const adopted = await backend.adopt("c1");

    expect(adopted.status).toBe("adopted");
    if (adopted.status === "adopted") expect(adopted.result.caseId).toBe("c1"); // harvested without a POST /v1/jobs
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
    expect(calls.some((c) => c.includes("everdict-c1-old01"))).toBe(false); // newest submission wins
  });

  it("adopt distinguishes absent (no job → safe re-dispatch) from unknown (ambiguous → may double-spend)", async () => {
    // The listing succeeds and finds nothing → definitively no job for this case → safe to re-dispatch.
    const empty: NomadHttp = {
      async request(_m, path) {
        if (path.startsWith("/v1/jobs?prefix=")) return { status: 200, text: "[]" };
        return { status: 404, text: "" };
      },
    };
    expect((await new NomadBackend({ addr: "http://n:4646", image: "i", http: empty }).adopt("c1")).status).toBe(
      "absent",
    );

    // The jobs listing itself errors → we CANNOT tell whether a job is live → unknown, never "absent".
    const listErr: NomadHttp = {
      async request() {
        return { status: 500, text: "boom" };
      },
    };
    expect((await new NomadBackend({ addr: "http://n:4646", image: "i", http: listErr }).adopt("c1")).status).toBe(
      "unknown",
    );

    // A job exists but its alloc logs are gone → the job is real, harvest failed → unknown (re-dispatch may double-spend).
    const goneLogs: NomadHttp = {
      async request(_m, path) {
        if (path.startsWith("/v1/jobs?prefix="))
          return { status: 200, text: JSON.stringify([{ ID: "everdict-c1-a", SubmitTime: 1 }]) };
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "a1", ClientStatus: "complete" }]) };
        return { status: 404, text: "" };
      },
    };
    expect(
      (await new NomadBackend({ addr: "http://n:4646", image: "i", http: goneLogs, pollIntervalMs: 1 }).adopt("c1"))
        .status,
    ).toBe("unknown");
  });

  it("kill deregisters every live everdict-<caseId>-* job (dead ones skipped, no purge)", async () => {
    const deletes: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        if (method === "DELETE") {
          deletes.push(path);
          return { status: 200, text: "{}" };
        }
        if (path.startsWith("/v1/jobs?prefix="))
          return {
            status: 200,
            text: JSON.stringify([
              { ID: "everdict-c1-live1", Namespace: "default", Status: "running" },
              { ID: "everdict-c1-done1", Namespace: "default", Status: "dead" },
              { ID: "everdict-c1-pend1", Namespace: "everdict-acme", Status: "pending" },
            ]),
          };
        return { status: 404, text: "" };
      },
    };
    await new NomadBackend({ addr: "http://n:4646", image: "i", http }).kill("c1");

    expect(deletes).toEqual(["/v1/job/everdict-c1-live1", "/v1/job/everdict-c1-pend1?namespace=everdict-acme"]);
    expect(deletes.every((d) => !d.includes("purge"))).toBe(true); // stop, never purge (the purge saga)
  });
});

describe("NomadBackend.exec — one-shot exec into a live case alloc", () => {
  it("resolves the newest RUNNING alloc and shells to `nomad alloc exec -task agent`", async () => {
    const http: NomadHttp = {
      async request(_method, path) {
        if (path.includes("/v1/jobs?prefix="))
          return { status: 200, text: JSON.stringify([{ ID: "everdict-c1-aa", SubmitTime: 2 }]) };
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "alloc-run", ClientStatus: "running" }]) };
        return { status: 404, text: "" };
      },
    };
    const runnerCalls: Array<{ bin: string; args: string[]; env: Record<string, string> }> = [];
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      apiToken: "tok",
      execRunner: async (bin, args, env) => {
        runnerCalls.push({ bin, args, env });
        return { code: 0, stdout: "EXEC_OK\n", stderr: "", exitCode: 0 } as never;
      },
    });
    const out = await backend.exec("c1", "ls /app");
    expect(out).toEqual({ stdout: "EXEC_OK\n", stderr: "", exitCode: 0 });
    const call = runnerCalls[0];
    expect(call?.bin).toBe("nomad");
    expect(call?.args).toEqual(["alloc", "exec", "-task", "agent", "alloc-run", "sh", "-c", "ls /app"]);
    expect(call?.env).toMatchObject({ NOMAD_ADDR: "http://nomad:4646", NOMAD_TOKEN: "tok" }); // API auth via env, not the alloc
  });

  it("returns undefined when there is no RUNNING alloc (nothing to exec into)", async () => {
    const http: NomadHttp = {
      async request(_method, path) {
        if (path.includes("/v1/jobs?prefix="))
          return { status: 200, text: JSON.stringify([{ ID: "everdict-c1-aa", SubmitTime: 1 }]) };
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "a", ClientStatus: "complete" }]) };
        return { status: 404, text: "" };
      },
    };
    let ran = false;
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      execRunner: async () => {
        ran = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(await backend.exec("c1", "ls")).toBeUndefined();
    expect(ran).toBe(false); // never shells out when there's no running alloc
  });
});

// A fake spawned child (EventEmitter-backed) so the handle wiring is testable without spawning a real `nomad`.
function fakeStreamChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter();
  const stdinErr = new EventEmitter();
  const writes: string[] = [];
  let killed = false;
  let writeShouldThrow = false;
  const child: StreamChild = {
    stdin: {
      write: (chunk) => {
        if (writeShouldThrow) throw new Error("EPIPE");
        writes.push(chunk);
      },
      on: (event, listener) => {
        stdinErr.on(event, listener);
      },
    },
    stdout: {
      on: (event, listener) => {
        stdout.on(event, listener);
      },
    },
    stderr: {
      on: (event, listener) => {
        stderr.on(event, listener);
      },
    },
    on: (event, listener) => {
      proc.on(event, listener);
    },
    kill: () => {
      killed = true;
    },
  };
  return {
    child,
    emitStdout: (s: string) => stdout.emit("data", Buffer.from(s)),
    emitStderr: (s: string) => stderr.emit("data", Buffer.from(s)),
    emitError: (e: Error) => proc.emit("error", e),
    emitClose: (code: number | null) => proc.emit("close", code),
    breakWrite: () => {
      writeShouldThrow = true;
    },
    writes,
    killed: () => killed,
  };
}

describe("streamHandleFor (ExecStreamHandle wiring — the terminal PTY handle)", () => {
  it("fans stdout+stderr to onData, delivers errors to onError, reports the exit code, and kills on close", () => {
    const f = fakeStreamChild();
    const handle = streamHandleFor(f.child);
    const chunks: string[] = [];
    handle.onData((c) => chunks.push(c));
    const errors: string[] = [];
    handle.onError((e) => errors.push(e.message));
    let exit: number | null = -99;
    handle.onExit((code) => {
      exit = code;
    });

    f.emitStdout("hello ");
    f.emitStderr("world");
    expect(chunks).toEqual(["hello ", "world"]);

    handle.write("ls\n");
    expect(f.writes).toEqual(["ls\n"]);

    f.emitError(new Error("spawn nomad ENOENT"));
    expect(errors).toEqual(["spawn nomad ENOENT"]);

    f.emitClose(0);
    expect(exit).toBe(0);

    handle.close();
    expect(f.killed()).toBe(true);
  });

  it("never crashes: a spawn 'error' with no onError subscriber is absorbed, and a write on a dead shell is swallowed", () => {
    const f = fakeStreamChild();
    const handle = streamHandleFor(f.child); // NB: no onError registered
    // Without the eager error sink this would be an uncaught 'error' event → a process crash.
    expect(() => f.emitError(new Error("boom"))).not.toThrow();
    // A keystroke after the shell exited must not propagate the EPIPE.
    f.breakWrite();
    expect(() => handle.write("late")).not.toThrow();
  });
});

describe("NomadBackend.dispatch cancellation (AbortSignal)", () => {
  it("a pre-aborted signal rejects before submitting anything", async () => {
    const ac = new AbortController();
    ac.abort();
    const calls: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        calls.push(`${method} ${path}`);
        return { status: 200, text: "{}" };
      },
    };
    await expect(
      new NomadBackend({ addr: "http://n:4646", image: "i", http }).dispatch(JOB, { signal: ac.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(calls).toEqual([]); // never even POSTed the job
  });

  it("aborting mid-poll stops the wait, reclaims the submitted job, and rejects with CANCELLED", async () => {
    const ac = new AbortController();
    const deletes: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        if (method === "POST" && path === "/v1/jobs") return { status: 200, text: "{}" };
        if (method === "DELETE") {
          deletes.push(path);
          return { status: 200, text: "" };
        }
        if (path.includes("/allocations")) {
          ac.abort(); // cancel while we're waiting for an alloc
          return { status: 200, text: "[]" }; // no alloc yet — the loop would poll again, but the abort short-circuits it
        }
        return { status: 404, text: "" };
      },
    };
    const backend = new NomadBackend({ addr: "http://n:4646", image: "i", http, pollIntervalMs: 1 });
    await expect(backend.dispatch(JOB, { signal: ac.signal })).rejects.toThrow(/aborted/i);
    expect(deletes.some((p) => p.includes("everdict-c1-"))).toBe(true); // the submitted job was deregistered, not left running
  });
});

describe("NomadBackend.probe (structured failure classification)", () => {
  it("classifies a rejected credential as auth, a network failure as unreachable, and success as no reason", async () => {
    const authFail: NomadHttp = {
      async request() {
        return { status: 403, text: "forbidden" };
      },
    };
    const a = await new NomadBackend({ addr: "http://n:4646", image: "i", http: authFail }).probe();
    expect(a.reachable).toBe(false);
    expect(a.reason).toBe("auth");

    const down: NomadHttp = {
      async request() {
        throw new Error("ECONNREFUSED");
      },
    };
    const d = await new NomadBackend({ addr: "http://n:4646", image: "i", http: down }).probe();
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe("unreachable");

    const up: NomadHttp = {
      async request() {
        return { status: 200, text: JSON.stringify({ member: { Name: "n1" } }) };
      },
    };
    const o = await new NomadBackend({ addr: "http://n:4646", image: "i", http: up }).probe();
    expect(o.reachable).toBe(true);
    expect(o.reason).toBeUndefined();
  });
});
