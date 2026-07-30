import {
  BadRequestError,
  type ComputeHandle,
  type Driver,
  FILE_EXECUTION_DEFAULT_TIMEOUT_SEC,
  FILE_EXECUTION_MAX_OUTPUT_CHARS,
  FILE_EXECUTION_MAX_PRODUCED_FILES,
  FILE_EXECUTION_MAX_TIMEOUT_SEC,
  FS_FILE_MAX_BYTES,
  type FileExecutionOutput,
  type FileExecutionRequest,
  type FileExecutionResult,
  type FsActor,
  NotFoundError,
  shq,
} from "@everdict/contracts";
import { fileRunPlanFor } from "@everdict/domain";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

// `timeout` exits 124 when it kills the command (GNU convention, and busybox follows it) — enforcing the limit
// INSIDE the sandbox makes "it ran too long" a deterministic exit code instead of a guess from wall-clock.
const TIMEOUT_EXIT_CODE = 124;
// The driver gets a slightly longer leash than the in-sandbox timeout, so the normal path is always the one that
// reports 124 rather than the driver killing the exec first.
const DRIVER_GRACE_SEC = 10;

// Run one file from the workspace filesystem and bring back what it printed and what it wrote.
//
// This is the viewer's "Run", not an eval: no harness, no grading, no run record. The isolation story is the
// Driver's — a container that exists for this one command and is disposed in a `finally`, whatever happened.
// The service is composed ONLY where a driver exists (`EVERDICT_FILE_EXECUTION_DRIVER`); everywhere else the
// route and the tool are simply absent, because "runs on the control-plane host" is not a fallback we offer.
export class FileExecutionService {
  constructor(
    private readonly fs: WorkspaceFs,
    private readonly driver: Driver,
  ) {}

  async run(tenant: string, input: FileExecutionRequest, actor?: FsActor): Promise<FileExecutionResult> {
    const plan = fileRunPlanFor(input.path, input.image);
    if (!plan) {
      throw new BadRequestError("BAD_REQUEST", { path: input.path }, `No interpreter for '${input.path}'.`);
    }
    const file = await this.fs.read(tenant, input.path);
    if (!file) throw new NotFoundError("NOT_FOUND", { path: input.path }, `'${input.path}' does not exist`);
    const source = decodeUtf8(file.data);
    if (source === undefined) {
      throw new BadRequestError("BAD_REQUEST", { path: input.path }, "Only a text file can be run.");
    }

    const name = input.path.split("/").at(-1) ?? input.path;
    const directory = input.path.includes("/") ? input.path.slice(0, input.path.lastIndexOf("/")) : "";
    const timeoutSec = Math.min(input.timeoutSec ?? FILE_EXECUTION_DEFAULT_TIMEOUT_SEC, FILE_EXECUTION_MAX_TIMEOUT_SEC);
    const command = `timeout ${timeoutSec} sh -c ${shq(plan.command)}`;

    const compute = await this.driver.provision({ os: "linux", image: plan.image, needs: ["shell"] });
    const startedAt = Date.now();
    try {
      await compute.writeFile(name, source);
      const result = await compute.exec(command, { timeoutSec: timeoutSec + DRIVER_GRACE_SEC });
      const outputs = await this.collectOutputs(compute, tenant, directory, name, actor);
      return {
        path: input.path,
        image: plan.image,
        command,
        exitCode: result.exitCode,
        stdout: clamp(result.stdout),
        stderr: clamp(result.stderr),
        truncated:
          result.stdout.length > FILE_EXECUTION_MAX_OUTPUT_CHARS ||
          result.stderr.length > FILE_EXECUTION_MAX_OUTPUT_CHARS,
        timedOut: result.exitCode === TIMEOUT_EXIT_CODE,
        durationMs: Date.now() - startedAt,
        outputs,
      };
    } finally {
      await compute.dispose();
    }
  }

  // Files the script left in its working directory, carried back NEXT TO the script — that is what makes a run
  // productive rather than merely observable (a chart, a converted document, a generated report). An existing
  // path is never overwritten: a run is not an edit, so a collision is reported, not resolved.
  private async collectOutputs(
    compute: ComputeHandle,
    tenant: string,
    directory: string,
    scriptName: string,
    actor?: FsActor,
  ): Promise<FileExecutionOutput[]> {
    const listing = await compute.exec("find . -type f");
    if (listing.exitCode !== 0) return [];
    const produced = listing.stdout
      .split("\n")
      .map((line) => line.trim().replace(/^\.\//, ""))
      .filter((line) => line !== "" && line !== scriptName)
      .sort()
      .slice(0, FILE_EXECUTION_MAX_PRODUCED_FILES);

    const outputs: FileExecutionOutput[] = [];
    for (const name of produced) {
      const measured = await compute.exec(`wc -c < ${shq(name)}`);
      const size = Number.parseInt(measured.stdout.trim(), 10);
      if (!Number.isFinite(size) || size > FS_FILE_MAX_BYTES) continue; // too big for the filesystem's own cap
      const target = directory === "" ? name : `${directory}/${name}`;
      const output: FileExecutionOutput = { path: target, name, size };
      // base64 so a produced PNG or spreadsheet survives the trip — `cat` would corrupt anything non-text.
      const encoded = await compute.exec(`base64 ${shq(name)}`);
      if (encoded.exitCode !== 0) continue;
      const data = new Uint8Array(Buffer.from(encoded.stdout.replace(/\s+/g, ""), "base64"));
      try {
        if (await this.fs.stat(tenant, target)) {
          outputs.push({ ...output, skipped: true });
          continue;
        }
        await this.fs.write(tenant, target, data, undefined, actor !== undefined ? { actor } : undefined);
        outputs.push(output);
      } catch {
        // An unrepresentable name (charset/depth) or a losing race — reported as skipped, never fatal to the run.
        outputs.push({ ...output, skipped: true });
      }
    }
    return outputs;
  }
}

function decodeUtf8(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

function clamp(stream: string): string {
  return stream.length > FILE_EXECUTION_MAX_OUTPUT_CHARS ? stream.slice(0, FILE_EXECUTION_MAX_OUTPUT_CHARS) : stream;
}
