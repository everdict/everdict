import type { ComputeHandle, ComputeSpec, Driver, ExecOpts, ExecResult, FsEntry, RunRecord } from "@everdict/contracts";
import { NO_IMAGE } from "@everdict/contracts";
import { BadRequestError, NotFoundError, PaymentRequiredError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { RunStore } from "../ports/run-store.js";
import type { FsFile, WorkspaceFs } from "../ports/workspace-fs.js";
import { FileExecutionService } from "./file-execution-service.js";

// Deterministic ids so a run row can be asserted without reading it back by a random uuid.
function seq(prefix: string): () => string {
  let i = 0;
  return () => `${prefix}-${i++}`;
}

// A filesystem that remembers what was written back — the run's productive half.
class FakeFs implements WorkspaceFs {
  readonly written = new Map<string, Uint8Array>();
  constructor(private readonly files: Record<string, string> = {}) {}
  async read(_tenant: string, path: string): Promise<FsFile | undefined> {
    const body = this.files[path];
    if (body === undefined) return undefined;
    const data = new TextEncoder().encode(body);
    return { entry: { path, name: path.split("/").at(-1) ?? path, kind: "file", size: data.byteLength }, data };
  }
  async stat(_tenant: string, path: string): Promise<FsEntry | undefined> {
    if (this.files[path] === undefined && !this.written.has(path)) return undefined;
    return { path, name: path.split("/").at(-1) ?? path, kind: "file" };
  }
  async write(_tenant: string, path: string, data: Uint8Array): Promise<FsEntry> {
    this.written.set(path, data);
    return { path, name: path.split("/").at(-1) ?? path, kind: "file", size: data.byteLength };
  }
  async list(): Promise<FsEntry[]> {
    throw new Error("unused");
  }
  async mkdir(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async remove(): Promise<number> {
    throw new Error("unused");
  }
  async move(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async writeRevisionBlob(): Promise<void> {
    throw new Error("unused");
  }
  async readRevisionBlob(): Promise<FsFile | undefined> {
    throw new Error("unused");
  }
  async removeRevisionBlobs(): Promise<number> {
    return 0;
  }
}

// A sandbox scripted by the test: `respond` answers each command, and the handle records the calls so a test can
// assert the file was placed and the container was always torn down.
class FakeDriver implements Driver {
  readonly id = "fake";
  readonly commands: string[] = [];
  readonly writes = new Map<string, string>();
  provisioned?: ComputeSpec;
  disposed = false;
  constructor(private readonly respond: (cmd: string) => ExecResult) {}
  async provision(spec: ComputeSpec): Promise<ComputeHandle> {
    this.provisioned = spec;
    const self = this;
    return {
      image: NO_IMAGE,
      async exec(cmd: string, _opts?: ExecOpts): Promise<ExecResult> {
        self.commands.push(cmd);
        return self.respond(cmd);
      },
      async writeFile(path: string, data: string): Promise<void> {
        self.writes.set(path, data);
      },
      async readFile(): Promise<string> {
        throw new Error("unused");
      },
      async dispose(): Promise<void> {
        self.disposed = true;
      },
    };
  }
}

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

// A minimal run ledger. Local rather than @everdict/db's InMemoryRunStore on purpose: db depends on THIS
// package, so importing it back would be the reverse edge the architecture forbids.
class FakeRuns implements RunStore {
  readonly rows = new Map<string, RunRecord>();
  readonly events: unknown[] = [];
  async create(record: RunRecord, events?: unknown[]): Promise<void> {
    this.rows.set(record.id, record);
    if (events) this.events.push(...events);
  }
  async update(id: string, patch: Partial<RunRecord>, events?: unknown[]): Promise<RunRecord | undefined> {
    const current = this.rows.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.rows.set(id, next);
    if (events) this.events.push(...events);
    return next;
  }
  async get(id: string): Promise<RunRecord | undefined> {
    return this.rows.get(id);
  }
  async list(tenant?: string): Promise<RunRecord[]> {
    return [...this.rows.values()].filter((r) => tenant === undefined || r.tenant === tenant);
  }
  async deleteByScorecard(): Promise<number> {
    return 0;
  }
  async countActiveByEnvelope(): Promise<number> {
    return 0;
  }
  async inFlightByTenant(): Promise<Record<string, number>> {
    return {};
  }
  // No children in this fixture — the queue-progress read is not this test's subject.
  async countChildrenByStatus() {
    return [];
  }
  async liveSessions(): Promise<[]> {
    return [];
  }
}

describe("FileExecutionService — running one workspace file", () => {
  it("places the file in a sandbox from the language's image and runs it under an in-sandbox timeout", async () => {
    const fs = new FakeFs({ "tasks/t1/report.py": "print('hi')\n" });
    const driver = new FakeDriver((cmd) => (cmd.startsWith("find") ? ok("./report.py\n") : ok("hi\n")));
    const service = new FileExecutionService(fs, { compute: driver });

    const result = await service.run("acme", { path: "tasks/t1/report.py" });

    expect(driver.provisioned?.image).toBe("python:3.13-slim");
    expect(driver.writes.get("report.py")).toBe("print('hi')\n");
    expect(result.command).toBe("timeout 60 sh -c 'python '\\''./report.py'\\'''");
    expect(result.stdout).toBe("hi\n");
    expect(result.exitCode).toBe(0);
    expect(driver.disposed).toBe(true);
  });

  it("carries produced files back next to the script", async () => {
    const fs = new FakeFs({ "reports/chart.py": "..." });
    const driver = new FakeDriver((cmd) => {
      if (cmd.startsWith("find")) return ok("./chart.py\n./chart.png\n");
      if (cmd.startsWith("wc -c")) return ok("4\n");
      if (cmd.startsWith("base64")) return ok(Buffer.from("PNG!").toString("base64"));
      return ok();
    });
    const service = new FileExecutionService(fs, { compute: driver });

    const result = await service.run("acme", { path: "reports/chart.py" });

    expect(result.outputs).toEqual([{ path: "reports/chart.png", name: "chart.png", size: 4 }]);
    expect(new TextDecoder().decode(fs.written.get("reports/chart.png"))).toBe("PNG!");
  });

  it("never overwrites an existing file — a run is not an edit", async () => {
    const fs = new FakeFs({ "reports/chart.py": "...", "reports/chart.png": "the one that was already there" });
    const driver = new FakeDriver((cmd) => {
      if (cmd.startsWith("find")) return ok("./chart.py\n./chart.png\n");
      if (cmd.startsWith("wc -c")) return ok("4\n");
      if (cmd.startsWith("base64")) return ok(Buffer.from("PNG!").toString("base64"));
      return ok();
    });
    const service = new FileExecutionService(fs, { compute: driver });

    const result = await service.run("acme", { path: "reports/chart.py" });

    expect(result.outputs).toEqual([{ path: "reports/chart.png", name: "chart.png", size: 4, skipped: true }]);
    expect(fs.written.has("reports/chart.png")).toBe(false);
  });

  it("reports a timeout as a timeout, from the sandbox's own exit code", async () => {
    const fs = new FakeFs({ "loop.sh": "while true; do :; done" });
    const driver = new FakeDriver((cmd) =>
      cmd.startsWith("find") ? ok("./loop.sh\n") : { exitCode: 124, stdout: "", stderr: "" },
    );
    const service = new FileExecutionService(fs, { compute: driver });

    const result = await service.run("acme", { path: "loop.sh", timeoutSec: 5 });

    expect(result.command.startsWith("timeout 5 ")).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("a failing script is a result, not an error — and the sandbox is still torn down", async () => {
    const fs = new FakeFs({ "boom.py": "raise SystemExit(2)" });
    const driver = new FakeDriver((cmd) =>
      cmd.startsWith("find") ? ok("./boom.py\n") : { exitCode: 2, stdout: "", stderr: "Traceback…" },
    );
    const service = new FileExecutionService(fs, { compute: driver });

    const result = await service.run("acme", { path: "boom.py" });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("Traceback…");
    expect(result.timedOut).toBe(false);
    expect(driver.disposed).toBe(true);
  });

  it("refuses a format it has no interpreter for, and a file that is not text", async () => {
    const driver = new FakeDriver(() => ok());
    const notes = new FileExecutionService(new FakeFs({ "notes.md": "# hi" }), { compute: driver });
    await expect(notes.run("acme", { path: "notes.md" })).rejects.toBeInstanceOf(BadRequestError);

    const missing = new FileExecutionService(new FakeFs({}), { compute: driver });
    await expect(missing.run("acme", { path: "gone.py" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("runs against a caller-chosen environment image, keeping the interpreter", async () => {
    const fs = new FakeFs({ "analyze.py": "..." });
    const driver = new FakeDriver((cmd) => (cmd.startsWith("find") ? ok("./analyze.py\n") : ok()));
    const service = new FileExecutionService(fs, { compute: driver });

    const result = await service.run("acme", { path: "analyze.py", image: "ghcr.io/acme/analysis:2.1.0" });

    expect(driver.provisioned?.image).toBe("ghcr.io/acme/analysis:2.1.0");
    expect(result.command).toContain("python");
  });

  // WHERE a script runs is the member's choice, on the same axis a run's placement.target names.
  it("runs on the WORKSPACE's own runtime when one is named — not the deployment's compute", async () => {
    const fs = new FakeFs({ "analyze.py": "..." });
    const deployment = new FakeDriver(() => ok());
    const theirs = new FakeDriver((cmd) => (cmd.startsWith("find") ? ok("./analyze.py\n") : ok()));
    const service = new FileExecutionService(fs, {
      compute: deployment,
      computeFor: async (tenant, runtime) => (tenant === "acme" && runtime === "nomad-eu" ? theirs : undefined),
    });

    await service.run("acme", { path: "analyze.py", runtime: "nomad-eu" });

    expect(theirs.provisioned).toBeDefined();
    expect(deployment.provisioned).toBeUndefined(); // never quietly on ours
  });

  it("404s a runtime the workspace does not have, instead of falling back to the deployment's compute", async () => {
    // A silent fallback would run a member's arbitrary code somewhere they did not choose — the whole reason
    // the axis exists is that "on whose machine" is an answer, not a default.
    const deployment = new FakeDriver(() => ok());
    const service = new FileExecutionService(new FakeFs({ "analyze.py": "..." }), {
      compute: deployment,
      computeFor: async () => undefined,
    });

    await expect(service.run("acme", { path: "analyze.py", runtime: "ghost" })).rejects.toBeInstanceOf(NotFoundError);
    expect(deployment.provisioned).toBeUndefined();
  });

  it("asks for a runtime by name when the deployment has no compute of its own", async () => {
    const service = new FileExecutionService(new FakeFs({ "analyze.py": "..." }), {
      computeFor: async () => undefined,
    });
    await expect(service.run("acme", { path: "analyze.py" })).rejects.toBeInstanceOf(BadRequestError);
  });

  // The ledger half: a file run is a `command` run. Before this, running a member's script left no trace at
  // all — and it now runs on the workspace's own cluster, which makes "who ran what, where" a real question.
  it("records the run, keeps a non-zero exit as a RESULT, and lists what it published", async () => {
    const runs = new FakeRuns();
    const fs = new FakeFs({ "analyze.py": "..." });
    const driver = new FakeDriver((cmd) => {
      if (cmd.startsWith("find")) return ok("./analyze.py\n./chart.png\n");
      if (cmd.startsWith("wc -c")) return ok("4\n");
      if (cmd.startsWith("base64")) return ok(Buffer.from("PNG!").toString("base64"));
      return { exitCode: 3, stdout: "", stderr: "boom" };
    });
    const service = new FileExecutionService(fs, {
      compute: driver,
      runs,
      newId: seq("run"),
      now: () => 1000,
    });

    const result = await service.run("acme", { path: "analyze.py" }, { kind: "member", subject: "alice" });

    const [record] = await runs.list("acme");
    expect(record).toMatchObject({
      tenant: "acme",
      kind: "command",
      lifetime: "task",
      caseId: "analyze.py",
      createdBy: "alice",
      // A script that exits 3 RAN. `failed` is reserved for "we could not run it" — conflating them would
      // make every failing test script look like broken infrastructure.
      status: "succeeded",
      outputs: { exitCode: 3, files: ["chart.png"] },
    });
    expect(result.exitCode).toBe(3);
  });

  it("says WHERE it ran when a runtime was named — the audit question the runtime axis created", async () => {
    const runs = new FakeRuns();
    const theirs = new FakeDriver((cmd) => (cmd.startsWith("find") ? ok("") : ok()));
    const service = new FileExecutionService(new FakeFs({ "a.py": "..." }), {
      computeFor: async () => theirs,
      runs,
      newId: seq("run"),
      now: () => 1000,
    });

    await service.run("acme", { path: "a.py", runtime: "nomad-eu" }, { kind: "member", subject: "alice" });

    expect((await runs.list("acme"))[0]).toMatchObject({
      runtime: "nomad-eu",
      placement: { where: "runtime", target: "nomad-eu" },
    });
  });

  it("marks the run FAILED when we could not run it — a sandbox fault is not the script's verdict", async () => {
    const runs = new FakeRuns();
    const broken: Driver = {
      id: "broken",
      async provision(): Promise<ComputeHandle> {
        throw new Error("no compute");
      },
      async reap(): Promise<void> {},
    };
    const service = new FileExecutionService(new FakeFs({ "a.py": "..." }), {
      compute: broken,
      runs,
      newId: seq("run"),
      now: () => 1000,
    });

    await expect(service.run("acme", { path: "a.py" }, { kind: "member", subject: "alice" })).rejects.toThrow();
    // The row is SETTLED, not left at `running`: a container that never came up is precisely the case the
    // ledger exists for, and an eternally-running row would be an orphan record of its own.
    expect((await runs.list("acme"))[0]).toMatchObject({ status: "failed", error: { message: "no compute" } });
  });

  // Admission (execution-model §5, the singular gate). This lane had none at all: a member — or an agent in
  // a loop — could take unbounded compute, and an agent's run spent against nobody's envelope.
  it("refuses past the tenant budget BEFORE taking a container", async () => {
    const driver = new FakeDriver(() => ok());
    const service = new FileExecutionService(new FakeFs({ "a.py": "..." }), {
      compute: driver,
      budget: {
        admit: () => {
          throw new PaymentRequiredError("BUDGET_EXCEEDED", {}, "over budget");
        },
        release: () => {},
        settle: () => {},
        usage: () => ({ runs: 0, usd: 0, tokens: 0 }),
      },
    });

    await expect(service.run("acme", { path: "a.py" })).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(driver.provisioned).toBeUndefined(); // a refusal costs nothing
  });

  it("an AGENT's run draws from its causer's envelope and is stamped with it", async () => {
    const runs = new FakeRuns();
    // The agent's turn, carrying the delegated slice every run it causes must draw from.
    await runs.create({
      id: "turn-1",
      tenant: "acme",
      harness: { id: "assistant", version: "1" },
      caseId: "chat",
      status: "running",
      kind: "agent",
      envelope: { id: "turn-1", capUsd: 5 },
      createdAt: "t",
      updatedAt: "t",
    });
    const service = new FileExecutionService(new FakeFs({ "a.py": "..." }), {
      compute: new FakeDriver((cmd) => (cmd.startsWith("find") ? ok("") : ok())),
      runs,
      newId: seq("run"),
      now: () => 1000,
    });

    await service.run("acme", { path: "a.py" }, { kind: "agent", subject: "bot", agentId: "a1" }, "turn-1");

    const row = [...runs.rows.values()].find((r) => r.kind === "command");
    expect(row).toMatchObject({
      origin: { causedByRunId: "turn-1" }, // the causal edge is audited, not implied
      // Inherited stamps carry only the id — the caps live on the ROOT record the id names, so there is one
      // place a cap can be read and no copy to go stale.
      envelope: { id: "turn-1" },
    });
  });

  it("refuses a causer that is not this workspace's run — causation is an audited edge, never a claim", async () => {
    const runs = new FakeRuns();
    const driver = new FakeDriver(() => ok());
    const service = new FileExecutionService(new FakeFs({ "a.py": "..." }), { compute: driver, runs });

    await expect(service.run("acme", { path: "a.py" }, undefined, "someone-elses-run")).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(driver.provisioned).toBeUndefined();
  });
});
