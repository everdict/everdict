import type { ComputeHandle, ComputeSpec, Driver, ExecOpts, ExecResult, FsEntry } from "@everdict/contracts";
import { BadRequestError, NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { FsFile, WorkspaceFs } from "../ports/workspace-fs.js";
import { FileExecutionService } from "./file-execution-service.js";

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

describe("FileExecutionService — running one workspace file", () => {
  it("places the file in a sandbox from the language's image and runs it under an in-sandbox timeout", async () => {
    const fs = new FakeFs({ "tasks/t1/report.py": "print('hi')\n" });
    const driver = new FakeDriver((cmd) => (cmd.startsWith("find") ? ok("./report.py\n") : ok("hi\n")));
    const service = new FileExecutionService(fs, driver);

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
    const service = new FileExecutionService(fs, driver);

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
    const service = new FileExecutionService(fs, driver);

    const result = await service.run("acme", { path: "reports/chart.py" });

    expect(result.outputs).toEqual([{ path: "reports/chart.png", name: "chart.png", size: 4, skipped: true }]);
    expect(fs.written.has("reports/chart.png")).toBe(false);
  });

  it("reports a timeout as a timeout, from the sandbox's own exit code", async () => {
    const fs = new FakeFs({ "loop.sh": "while true; do :; done" });
    const driver = new FakeDriver((cmd) =>
      cmd.startsWith("find") ? ok("./loop.sh\n") : { exitCode: 124, stdout: "", stderr: "" },
    );
    const service = new FileExecutionService(fs, driver);

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
    const service = new FileExecutionService(fs, driver);

    const result = await service.run("acme", { path: "boom.py" });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("Traceback…");
    expect(result.timedOut).toBe(false);
    expect(driver.disposed).toBe(true);
  });

  it("refuses a format it has no interpreter for, and a file that is not text", async () => {
    const driver = new FakeDriver(() => ok());
    const notes = new FileExecutionService(new FakeFs({ "notes.md": "# hi" }), driver);
    await expect(notes.run("acme", { path: "notes.md" })).rejects.toBeInstanceOf(BadRequestError);

    const missing = new FileExecutionService(new FakeFs({}), driver);
    await expect(missing.run("acme", { path: "gone.py" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("runs against a caller-chosen environment image, keeping the interpreter", async () => {
    const fs = new FakeFs({ "analyze.py": "..." });
    const driver = new FakeDriver((cmd) => (cmd.startsWith("find") ? ok("./analyze.py\n") : ok()));
    const service = new FileExecutionService(fs, driver);

    const result = await service.run("acme", { path: "analyze.py", image: "ghcr.io/acme/analysis:2.1.0" });

    expect(driver.provisioned?.image).toBe("ghcr.io/acme/analysis:2.1.0");
    expect(result.command).toContain("python");
  });

  // WHERE a script runs is the member's choice, on the same axis a run's placement.target names.
  it("runs on the WORKSPACE's own runtime when one is named — not the deployment's compute", async () => {
    const fs = new FakeFs({ "analyze.py": "..." });
    const deployment = new FakeDriver(() => ok());
    const theirs = new FakeDriver((cmd) => (cmd.startsWith("find") ? ok("./analyze.py\n") : ok()));
    const service = new FileExecutionService(fs, deployment, async (tenant, runtime) =>
      tenant === "acme" && runtime === "nomad-eu" ? theirs : undefined,
    );

    await service.run("acme", { path: "analyze.py", runtime: "nomad-eu" });

    expect(theirs.provisioned).toBeDefined();
    expect(deployment.provisioned).toBeUndefined(); // never quietly on ours
  });

  it("404s a runtime the workspace does not have, instead of falling back to the deployment's compute", async () => {
    // A silent fallback would run a member's arbitrary code somewhere they did not choose — the whole reason
    // the axis exists is that "on whose machine" is an answer, not a default.
    const deployment = new FakeDriver(() => ok());
    const service = new FileExecutionService(new FakeFs({ "analyze.py": "..." }), deployment, async () => undefined);

    await expect(service.run("acme", { path: "analyze.py", runtime: "ghost" })).rejects.toBeInstanceOf(NotFoundError);
    expect(deployment.provisioned).toBeUndefined();
  });

  it("asks for a runtime by name when the deployment has no compute of its own", async () => {
    const service = new FileExecutionService(new FakeFs({ "analyze.py": "..." }), undefined, async () => undefined);
    await expect(service.run("acme", { path: "analyze.py" })).rejects.toBeInstanceOf(BadRequestError);
  });
});
