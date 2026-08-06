import { RunService } from "@everdict/application-control";
import type { Authenticator } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { Run } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// The run workbench's live repo reads (GET /runs/:id/fs + /fs/file) — the explorer/editor halves of the
// "VS Code view" on a coding case. These pin the transport contract: creator-or-admin gating (they read the
// sandbox), workspace scoping as 404, path validation as 400, and the found=false shape for a repo-less sandbox.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("no dispatch in fs tests");
  },
};

const asMember = (subject: string, roles: string[] = ["admin"]): Authenticator => ({
  async authenticate() {
    return { subject, workspace: "acme", roles, via: "oidc" as const };
  },
});

const bearer = { authorization: "Bearer t" };

type ExecResult = { stdout: string; stderr: string; exitCode: number };

async function build(viewer: string, opts: { exec?: (command: string) => ExecResult; roles?: string[] } = {}) {
  const store = new InMemoryRunStore();
  await store.create(
    Run.newQueued({
      id: "eval-1",
      tenant: "acme",
      harness: { id: "cc", version: "1.0.0" },
      evalCase: {
        id: "c1",
        env: { kind: "repo", source: { files: { "README.md": "seed" } } },
        task: "fix it",
        graders: [],
        timeoutSec: 60,
        tags: [],
      },
      submittedBy: "alice",
      now: "2026-08-06T00:00:00.000Z",
    }),
  );
  return buildServer({
    service: new RunService({
      dispatcher: unusedDispatcher,
      store,
      ...(opts.exec
        ? {
            execInSandbox: async (_t: string, _r: string | undefined, _c: string, command: string) =>
              opts.exec?.(command),
          }
        : {}),
    }),
    requireAuth: true,
    authenticator: asMember(viewer, opts.roles),
  });
}

const treeStdout = ["src/app.ts", "README.md", "", "__EVERDICT_FS__", " M src/app.ts", ""].join("\n");

describe("GET /runs/:id/fs (run workbench explorer)", () => {
  it("lists the live repo files with working-tree status for the run's creator", async () => {
    const app = await build("alice", { exec: () => ({ stdout: treeStdout, stderr: "", exitCode: 0 }) });
    const res = await app.inject({ method: "GET", url: "/runs/eval-1/fs", headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "queued",
      found: true,
      files: [{ path: "README.md" }, { path: "src/app.ts", status: "modified" }],
      truncated: false,
    });
  });

  it("refuses another member (403) and hides a missing run (404)", async () => {
    const other = await build("bob", {
      exec: () => ({ stdout: treeStdout, stderr: "", exitCode: 0 }),
      roles: ["member"],
    });
    expect((await other.inject({ method: "GET", url: "/runs/eval-1/fs", headers: bearer })).statusCode).toBe(403);
    expect((await other.inject({ method: "GET", url: "/runs/nope/fs", headers: bearer })).statusCode).toBe(404);
  });

  it("answers found=false when the sandbox has no git worktree or no exec channel exists", async () => {
    const noRepo = await build("alice", { exec: () => ({ stdout: "", stderr: "", exitCode: 43 }) });
    const res = await noRepo.inject({ method: "GET", url: "/runs/eval-1/fs", headers: bearer });
    expect(res.json()).toMatchObject({ found: false, files: [] });

    const noExec = await build("alice");
    const res2 = await noExec.inject({ method: "GET", url: "/runs/eval-1/fs", headers: bearer });
    expect(res2.json()).toMatchObject({ found: false });
  });
});

describe("GET /runs/:id/fs/file (run workbench editor pane)", () => {
  it("serves one file's decoded content plus its working-tree diff", async () => {
    const body = "export const x = 1\n";
    const diff = "diff --git a/src/app.ts b/src/app.ts\n+export const x = 1\n";
    const stdout = `${Buffer.byteLength(body)}\n__EVERDICT_FS__\n${Buffer.from(body).toString(
      "base64",
    )}\n__EVERDICT_FS_DIFF__\n${diff}`;
    const app = await build("alice", { exec: () => ({ stdout, stderr: "", exitCode: 0 }) });
    const res = await app.inject({ method: "GET", url: "/runs/eval-1/fs/file?path=src%2Fapp.ts", headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "queued",
      found: true,
      path: "src/app.ts",
      size: Buffer.byteLength(body),
      binary: false,
      truncated: false,
      content: body,
      diff,
    });
  });

  it("refuses a traversal path with 400 before any shell sees it", async () => {
    const commands: string[] = [];
    const app = await build("alice", {
      exec: (command) => {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/runs/eval-1/fs/file?path=${encodeURIComponent("../../etc/passwd")}`,
      headers: bearer,
    });
    expect(res.statusCode).toBe(400);
    expect(commands).toHaveLength(0);
    // Missing path is a 400 too (presence is the transport's check).
    expect((await app.inject({ method: "GET", url: "/runs/eval-1/fs/file", headers: bearer })).statusCode).toBe(400);
  });
});
