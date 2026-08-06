import type { RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "../ports/dispatcher.js";
import type { RunStore } from "../ports/run-store.js";
import { RunService } from "./run-service.js";

// Local store double (application-control cannot depend on @everdict/db — layer direction). Only the reads
// the workbench methods touch are real; the rest satisfy the port.
function fakeStore(records: RunRecord[]): RunStore {
  const rows = new Map(records.map((r) => [r.id, r]));
  return {
    async create(record: RunRecord) {
      rows.set(record.id, record);
    },
    async update(id: string, patch: Partial<RunRecord>) {
      const cur = rows.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      rows.set(id, next);
      return next;
    },
    async get(id: string) {
      return rows.get(id);
    },
    async list() {
      return [...rows.values()];
    },
    async deleteByScorecard() {
      return 0;
    },
    async countActiveByEnvelope() {
      return 0;
    },
    async liveSessions() {
      return [];
    },
  };
}

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("not under test");
  },
};

const runningRun = (id: string): RunRecord => ({
  id,
  tenant: "acme",
  harness: { id: "cc", version: "1.0.0" },
  caseId: "case-1",
  status: "running",
  runtime: "nomad-dev",
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
});

type ExecResult = { stdout: string; stderr: string; exitCode: number };
function serviceWithExec(exec: ((command: string) => ExecResult) | undefined, record = runningRun("r1")) {
  const commands: string[] = [];
  const service = new RunService({
    dispatcher: unusedDispatcher,
    store: fakeStore([record]),
    ...(exec
      ? {
          execInSandbox: async (_tenant: string, _runtime: string | undefined, _caseId: string, command: string) => {
            commands.push(command);
            return exec(command);
          },
        }
      : {}),
  });
  return { service, commands };
}

describe("RunService.fsTree (run workbench repo listing)", () => {
  it("lists the repo files with working-tree status badges folded onto them", async () => {
    const stdout = [
      "src/index.ts",
      "src/new.ts",
      "README.md",
      "gone.ts",
      "",
      "__EVERDICT_FS__",
      " M src/index.ts",
      "?? src/new.ts",
      " D gone.ts",
      "",
    ].join("\n");
    const { service } = serviceWithExec(() => ({ stdout, stderr: "", exitCode: 0 }));

    const out = await service.fsTree("r1");
    expect(out?.tree).toBeDefined();
    expect(out?.tree?.truncated).toBe(false);
    expect(out?.tree?.files).toEqual([
      { path: "README.md" },
      { path: "gone.ts", status: "deleted" },
      { path: "src/index.ts", status: "modified" },
      { path: "src/new.ts", status: "added" },
    ]);
  });

  it("reads as no tree when the sandbox is not a git worktree (non-repo env) or has no live container", async () => {
    // The probe command exits 43 for a sandbox without a repo — the workbench renders nothing, not a wrong fs.
    const { service: notARepo } = serviceWithExec(() => ({ stdout: "", stderr: "", exitCode: 43 }));
    expect((await notARepo.fsTree("r1"))?.tree).toBeUndefined();

    const { service: noExecChannel } = serviceWithExec(undefined);
    expect((await noExecChannel.fsTree("r1"))?.tree).toBeUndefined();

    const { service } = serviceWithExec(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    expect(await service.fsTree("missing")).toBeUndefined();
  });
});

describe("RunService.fsFile (run workbench file read)", () => {
  it("returns UTF-8 content decoded from the base64 transport plus the file's working-tree diff", async () => {
    const body = "hello «repo»\n";
    const diff = "diff --git a/f.ts b/f.ts\n+hello\n";
    const stdout = `${Buffer.byteLength(body)}\n__EVERDICT_FS__\n${Buffer.from(body).toString(
      "base64",
    )}\n__EVERDICT_FS_DIFF__\n${diff}`;
    const { service, commands } = serviceWithExec(() => ({ stdout, stderr: "", exitCode: 0 }));

    const out = await service.fsFile("r1", "src/f.ts");
    expect(out?.file).toEqual({
      path: "src/f.ts",
      size: Buffer.byteLength(body),
      binary: false,
      truncated: false,
      content: body,
      diff,
    });
    // The path travels as shell DATA (single-quoted), never syntax.
    expect(commands[0]).toContain("'src/f.ts'");
  });

  it("reports a binary file instead of shipping garbage, and flags an over-cap file as truncated", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0x47]);
    const stdout = `500000\n__EVERDICT_FS__\n${bytes.toString("base64")}\n__EVERDICT_FS_DIFF__\n`;
    const { service } = serviceWithExec(() => ({ stdout, stderr: "", exitCode: 0 }));

    const out = await service.fsFile("r1", "logo.png");
    expect(out?.file?.binary).toBe(true);
    expect(out?.file?.content).toBe("");
    expect(out?.file?.truncated).toBe(true);
    expect(out?.file?.diff).toBe("");
  });

  it("escapes a single quote in the path so it cannot break out of the shell quoting", async () => {
    const stdout = `1\n__EVERDICT_FS__\n${Buffer.from("x").toString("base64")}\n__EVERDICT_FS_DIFF__\n`;
    const { service, commands } = serviceWithExec(() => ({ stdout, stderr: "", exitCode: 0 }));
    await service.fsFile("r1", "it's.md");
    expect(commands[0]).toContain("'it'\\''s.md'");
  });

  it("refuses traversal, absolute and control-character paths before any shell sees them", async () => {
    const { service, commands } = serviceWithExec(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    for (const path of ["../secrets", "a/../../b", "/etc/passwd", "a\nb", ""]) {
      await expect(service.fsFile("r1", path)).rejects.toMatchObject({ status: 400 });
    }
    expect(commands).toHaveLength(0);
  });

  it("reads as no file when the path does not exist in the sandbox", async () => {
    const { service } = serviceWithExec(() => ({ stdout: "", stderr: "", exitCode: 44 }));
    expect((await service.fsFile("r1", "nope.ts"))?.file).toBeUndefined();
  });
});

describe("RunService fs reads on a self-hosted run (parked-request seam)", () => {
  const selfHostedRun: RunRecord = { ...runningRun("r-self"), runtime: "self:runner-1" };

  it("routes through runnerCaseFs (keyed by the derived runId) and never execs", async () => {
    const execCommands: string[] = [];
    const asked: string[] = [];
    const tree = { files: [{ path: "a.py" }], truncated: false };
    const file = { path: "a.py", size: 1, binary: false, truncated: false, content: "x", diff: "" };
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store: fakeStore([selfHostedRun]),
      execInSandbox: async (_t, _r, _c, command) => {
        execCommands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      runnerCaseFs: {
        tree: async (runId) => {
          asked.push(`tree:${runId}`);
          return tree;
        },
        file: async (runId, path) => {
          asked.push(`file:${runId}:${path}`);
          return file;
        },
      },
    });

    expect((await service.fsTree("r-self"))?.tree).toEqual(tree);
    expect((await service.fsFile("r-self", "a.py"))?.file).toEqual(file);
    expect(asked).toEqual(["tree:evd-run-r-self", "file:evd-run-r-self:a.py"]);
    expect(execCommands).toHaveLength(0); // the control plane cannot exec into a runner's sandbox
  });

  it("reads as no tree when the seam is not wired (old composition) — never falls back to exec", async () => {
    const { service, commands } = serviceWithExec(() => ({ stdout: "", stderr: "", exitCode: 0 }), selfHostedRun);
    expect((await service.fsTree("r-self"))?.tree).toBeUndefined();
    expect(commands).toHaveLength(0);
  });
});
