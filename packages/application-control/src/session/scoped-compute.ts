import type { ComputeHandle, ExecOpts } from "@everdict/contracts";
import { shq } from "@everdict/contracts";

// Rebase a live session's ComputeHandle under a per-task prefix ("tasks/<n>") so consecutive test cases
// run in fresh working directories inside the SAME container — eval-case independence, while the installed
// harness and its dependencies stay warm at the container level. Relative cwd/file paths are rebased;
// absolute paths pass through (documented caveat: a spec with an absolute workDir gets no per-task
// isolation). docker's `exec -w` requires the directory to EXIST, so each distinct rebased cwd is mkdir'd
// once before its first exec. execStream is forwarded ONLY when the inner handle has it — support must
// stay detectable (the harness picks its incremental path by presence).
export function scopedComputeHandle(inner: ComputeHandle, prefix: string): ComputeHandle {
  const made = new Set<string>();
  const rebase = (p: string | undefined): string => {
    if (p === undefined || p === "") return prefix;
    return p.startsWith("/") ? p : `${prefix}/${p}`;
  };
  const ensureDir = async (cwd: string): Promise<void> => {
    if (cwd.startsWith("/") || made.has(cwd)) return; // absolute: the spec owns that path
    made.add(cwd);
    await inner.exec(`mkdir -p ${shq(cwd)}`);
  };
  const scopedOpts = (opts?: ExecOpts): ExecOpts => ({ ...opts, cwd: rebase(opts?.cwd) });
  const scoped: ComputeHandle = {
    ...(inner.id !== undefined ? { id: inner.id } : {}),
    async exec(cmd, opts) {
      const next = scopedOpts(opts);
      await ensureDir(next.cwd ?? prefix);
      return inner.exec(cmd, next);
    },
    async writeFile(path, data) {
      return inner.writeFile(rebase(path), data);
    },
    async readFile(path) {
      return inner.readFile(rebase(path));
    },
    async dispose() {
      // A task scope never owns the container — the session's teardown does.
    },
  };
  const innerStream = inner.execStream?.bind(inner);
  if (innerStream) {
    scoped.execStream = async (cmd, onChunk, opts) => {
      const next = scopedOpts(opts);
      await ensureDir(next.cwd ?? prefix);
      return innerStream(cmd, onChunk, next);
    };
  }
  return scoped;
}
