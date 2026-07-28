import type { CapabilityStore, SecretStore } from "@everdict/application-control";
import type { CapabilityRecord, CodeToolSpec, ComputeHandle, ExecResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { CodeToolRuntime } from "./code-tools.js";
import { type CodeTryDeps, runCodeToolTry } from "./code-try.js";
import type { Principal } from "./principal.js";

function fakeHandle(exec: (cmd: string, opts?: { env?: Record<string, string> }) => Promise<ExecResult>) {
  const files = new Map<string, string>();
  let disposed = false;
  const handle: ComputeHandle = {
    exec: async (cmd, opts) => exec(cmd, opts),
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    readFile: async (path) => files.get(path) ?? "",
    dispose: async () => {
      disposed = true;
    },
  };
  return { handle, files, disposed: () => disposed };
}

const principal: Principal = { subject: "alice", workspace: "acme", roles: ["member"] };

const spec = (over: Partial<CodeToolSpec> = {}): CodeToolSpec => ({
  type: "code",
  language: "node",
  code: "console.log(JSON.stringify({content:'hi',isError:false}))",
  parametersSchema: {},
  isReadOnly: true,
  requiredSecrets: [],
  examples: [],
  ...over,
});

const record = (owner: string, over: Partial<CapabilityRecord> = {}): CapabilityRecord => ({
  id: "scorer",
  tenant: owner,
  version: "1.0.0",
  name: "scorer",
  description: "d",
  spec: spec(),
  visibility: "public",
  sharedWith: [],
  tags: [],
  createdBy: "owner",
  createdAt: "t",
  ...over,
});

function capStore(records: CapabilityRecord[]): CapabilityStore {
  return {
    getVersion: async (owner: string, id: string, version: string) =>
      records.find((r) => r.tenant === owner && r.id === id && r.version === version),
  } as unknown as CapabilityStore;
}

function secretStore(workspace: Record<string, string>, user: Record<string, string> = {}): SecretStore {
  return { scopedEntries: async () => ({ workspace, user }) } as unknown as SecretStore;
}

describe("runCodeToolTry", () => {
  it("check mode runs a parse-only validation (node --check) and never writes an input file", async () => {
    let ranCmd = "";
    const f = fakeHandle(async (cmd) => {
      ranCmd = cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const deps: CodeTryDeps = { runtime: { provision: async () => f.handle, isolated: false } };
    const res = await runCodeToolTry(
      deps,
      principal,
      "check",
      { kind: "spec", name: "draft", spec: spec() },
      undefined,
    );
    expect(res.ok).toBe(true);
    expect(ranCmd).toContain("node --check");
    expect([...f.files.keys()]).toEqual(["/tmp/everdict-tool-check.mjs"]); // source only — check executes nothing
    expect(f.disposed()).toBe(true);
  });

  it("check mode surfaces the interpreter diagnostics on a syntax error", async () => {
    const f = fakeHandle(async () => ({ exitCode: 1, stdout: "", stderr: "SyntaxError: Unexpected token" }));
    const deps: CodeTryDeps = { runtime: { provision: async () => f.handle, isolated: false } };
    const res = await runCodeToolTry(
      deps,
      principal,
      "check",
      { kind: "spec", name: "draft", spec: spec({ code: "const {" }) },
      undefined,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("SyntaxError");
  });

  it("run mode executes a draft spec with the example input, exactly like the agent would", async () => {
    const f = fakeHandle(async () => ({
      exitCode: 0,
      stdout: '{"content":"result for q","isError":false}',
      stderr: "",
    }));
    const deps: CodeTryDeps = { runtime: { provision: async () => f.handle, isolated: false } };
    const res = await runCodeToolTry(
      deps,
      principal,
      "run",
      { kind: "spec", name: "draft", spec: spec() },
      { q: "hello" },
    );
    expect(res).toMatchObject({ mode: "run", ok: true, content: "result for q", missingSecrets: [] });
    expect(f.files.get("/tmp/everdict-tool-input.json")).toBe(JSON.stringify({ q: "hello" }));
  });

  it("run mode binds requiredSecrets by declared name (workspace tier first) and reports the unresolved ones", async () => {
    let gotEnv: Record<string, string> | undefined;
    const f = fakeHandle(async (_cmd, opts) => {
      gotEnv = opts?.env;
      return { exitCode: 0, stdout: '{"content":"ok","isError":false}', stderr: "" };
    });
    const deps: CodeTryDeps = {
      runtime: { provision: async () => f.handle, isolated: false },
      secretStore: secretStore({ API_KEY: "ws-value" }),
      capabilityStore: capStore([
        record("acme", {
          spec: spec({
            requiredSecrets: [
              { name: "API_KEY", description: "" },
              { name: "OTHER_KEY", description: "" },
            ],
          }),
        }),
      ]),
    };
    const res = await runCodeToolTry(
      deps,
      principal,
      "run",
      { kind: "ref", source: "acme", id: "scorer", version: "1.0.0" },
      {},
    );
    expect(res.ok).toBe(true);
    expect(gotEnv).toEqual({ API_KEY: "ws-value" });
    expect(res.missingSecrets).toEqual(["OTHER_KEY"]);
  });

  it("refuses to RUN another workspace's code on a non-isolated runtime (the agent's sandbox gate)", async () => {
    const f = fakeHandle(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    const deps: CodeTryDeps = {
      runtime: { provision: async () => f.handle, isolated: false },
      capabilityStore: capStore([record("other-ws")]),
    };
    await expect(
      runCodeToolTry(deps, principal, "run", { kind: "ref", source: "other-ws", id: "scorer", version: "1.0.0" }, {}),
    ).rejects.toThrow(/isolated/);
    // On an ISOLATED runtime the same target runs.
    const iso: CodeTryDeps = { ...deps, runtime: { provision: async () => f.handle, isolated: true } };
    const res = await runCodeToolTry(
      iso,
      principal,
      "run",
      { kind: "ref", source: "other-ws", id: "scorer", version: "1.0.0" },
      {},
    );
    expect(res.mode).toBe("run");
  });

  it("an invisible or non-code capability ref is NOT_FOUND / BAD_REQUEST (no existence leak)", async () => {
    const priv = record("other-ws", { visibility: "private" });
    const deps: CodeTryDeps = {
      runtime: {
        provision: async () => fakeHandle(async () => ({ exitCode: 0, stdout: "", stderr: "" })).handle,
        isolated: true,
      },
      capabilityStore: capStore([priv]),
    };
    await expect(
      runCodeToolTry(
        deps,
        principal,
        "check",
        { kind: "ref", source: "other-ws", id: "scorer", version: "1.0.0" },
        undefined,
      ),
    ).rejects.toThrow(/not found/);
  });
});
