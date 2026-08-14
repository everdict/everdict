import type { RunRecord } from "@everdict/contracts";
import { type PolicyResolution, composeVerdictPolicy } from "@everdict/domain";
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
    async inFlightByTenant() {
      return {};
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

// C4 (review §4): the served RunRecord.verdict is an APPLICATION-layer derivation — the DB adapter cannot
// know which policy judged a record, so it must not interpret evidence. A scorecard child is judged under
// its parent's stamped/composed policy; the run detail and the scorecard case dialog must answer
// identically about the same CaseResult.
describe("RunService verdict derivation — the application layer owns the interpretation", () => {
  const settled = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
    ...runningRun(id),
    status: "succeeded",
    result: {
      caseId: "case-1",
      harness: "cc@1.0.0",
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      // Under the DEFAULT ladder the judge rung decides (fail); under a policy declaring custom_gate as
      // ground truth, custom_gate outranks the judge (pass) — the two policies genuinely disagree.
      scores: [
        { graderId: "judge", metric: "judge:quality", value: 0, pass: false },
        { graderId: "custom_gate", metric: "custom_gate", value: 1, pass: true },
      ],
    },
    ...over,
  });

  it("a standalone run derives its verdict under the live default ladder — it has no stamp by construction", async () => {
    const service = new RunService({ dispatcher: unusedDispatcher, store: fakeStore([settled("r1")]) });
    expect((await service.get("r1"))?.verdict).toBe(false); // judge rung decides
  });

  it("a scorecard CHILD derives its verdict under its PARENT's stamped policy — run detail ≡ case dialog", async () => {
    // Regression: the DB adapter derived every verdict under the default ladder, so a child of a batch
    // judged under a composed policy showed FAIL on the run detail while the scorecard case dialog said
    // PASS — the same evidence, two answers, one click apart.
    const composed = composeVerdictPolicy([{ id: "custom_gate", authority: "ground_truth" }]);
    const resolved: PolicyResolution = { status: "resolved", policy: composed };
    const asked: string[] = [];
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store: fakeStore([
        settled("c1", { parentScorecardId: "sc-1" }),
        settled("c2", { parentScorecardId: "sc-1", caseId: "case-2" }),
      ]),
      scorecardPolicy: async (_tenant, scorecardId) => {
        asked.push(scorecardId);
        return resolved;
      },
    });
    expect((await service.get("c1"))?.verdict).toBe(true); // custom ground truth outranks the judge
    // The list batches: one policy resolution per distinct parent, not per row.
    asked.length = 0;
    const rows = await service.list("acme", { scorecardId: "sc-1" });
    expect(rows.map((r) => r.verdict)).toEqual([true, true]);
    expect(asked).toEqual(["sc-1"]);
  });

  it("a child whose parent policy is unresolvable (or the seam unwired) serves NO verdict — fail-closed", async () => {
    const child = settled("c1", { parentScorecardId: "sc-gone" });
    const unwired = new RunService({ dispatcher: unusedDispatcher, store: fakeStore([child]) });
    expect((await unwired.get("c1"))?.verdict).toBeUndefined();
    const unresolvable = new RunService({
      dispatcher: unusedDispatcher,
      store: fakeStore([child]),
      scorecardPolicy: async () => ({
        status: "unresolvable",
        ref: { id: "composed", version: "x", digest: "sha256:gone" },
      }),
    });
    // Never a silent re-judgement under today's ladder: without the batch's rules, no claim is made.
    expect((await unresolvable.get("c1"))?.verdict).toBeUndefined();
  });
});

// ── THE STANDALONE TERMINAL ROW IS BORN FINAL (arch-review 41 P1) ────────────────────────────────────
describe("standalone finality — the terminal write itself carries the evidence refs", () => {
  it("the succeed patch includes recordingRef; no post-terminal patch amends the result", async () => {
    // Pre-fix order was settle → seal → follow-up `store.update(id, { result })`: a crash between the two
    // published a SUCCEEDED run (completion fact and all) whose recordingRef never landed, and the follow-up
    // amended a terminal result under a weaker guard. The seal is attempt-generation-fenced, so it moves
    // BEFORE the terminal CAS and the ref rides the one terminal write.
    const patches: Array<Partial<RunRecord>> = [];
    const rows = new Map<string, RunRecord>();
    const store: RunStore = {
      async create(record: RunRecord) {
        rows.set(record.id, record);
      },
      async update(id: string, patch: Partial<RunRecord>) {
        const cur = rows.get(id);
        if (!cur) return undefined;
        patches.push(patch);
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
      async inFlightByTenant() {
        return {};
      },
      async liveSessions() {
        return [];
      },
    };
    const sealed: Array<{ runId: string; generation: number }> = [];
    const service = new RunService({
      dispatcher: {
        async dispatch() {
          return {
            caseId: "case-1",
            harness: "cc@1.0.0",
            trace: [],
            snapshot: { kind: "prompt" as const, output: "done" },
            scores: [],
          };
        },
      },
      store,
      recordingStore: {
        async open() {
          return 1;
        },
        async append() {},
        async peek() {
          return undefined;
        },
        async get() {
          return undefined;
        },
        async seal(runId: string, _meta: unknown, generation: number) {
          sealed.push({ runId, generation });
          return { ref: `${runId}#g${generation}`, frameCount: 1, byteSize: 10 };
        },
      } as never,
    });
    const record = await service.submit({
      tenant: "acme",
      harness: { id: "cc", version: "1.0.0" },
      case: { id: "case-1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    });
    // wait for the async track to settle the run
    const deadline = Date.now() + 5_000;
    while ((await store.get(record.id))?.status !== "succeeded") {
      if (Date.now() > deadline) throw new Error("run never settled");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sealed).toHaveLength(1);
    // THE terminal patch carries the ref…
    const terminal = patches.find((p) => p.status === "succeeded");
    expect(terminal?.result?.recordingRef?.ref).toBe(`evd-run-${record.id}#g1`);
    // …and nothing after it touches `result` again (no post-terminal amendment).
    const terminalIndex = patches.findIndex((p) => p.status === "succeeded");
    for (const later of patches.slice(terminalIndex + 1)) expect(later.result).toBeUndefined();
  });
});
