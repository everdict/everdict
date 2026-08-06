import type { CaseFsFilePayload, CaseFsTreePayload } from "@everdict/contracts";

// The run workbench's live repo reads — ONE implementation of the git commands + parsers, shared by both
// execution lanes: the managed lane execs them into the sandbox from the control plane (RunService.fsTree/fsFile
// over Observable.exec), and the self-hosted lane runs the very same commands INSIDE the case (runCase's caseFs
// servicing loop answering parked requests). Status mirrors git's working-tree verdict, folded to the three words
// a file explorer badges (an untracked file reads as added — that is what it will be).

// Land the shell in the case's repo before any git command: the job-runner materializes it at `work/` under the
// DRIVER's sandbox root (LocalDriver = mkdtemp /tmp/everdict-*), while an orchestrator exec starts at the image
// WORKDIR — so try the relative `work` first (in-sandbox execution and same-cwd setups) and fall back to the
// driver's tmp sandbox glob. Live-found on Nomad: without the fallback every fs read answered exit 43.
const FS_ENTER_REPO = 'for d in work /tmp/everdict-*/work; do [ -d "$d/.git" ] && cd "$d" && break; done 2>/dev/null; ';

const FS_SENTINEL = "__EVERDICT_FS__";
const FS_DIFF_SENTINEL = "__EVERDICT_FS_DIFF__";
const MAX_FS_ENTRIES = 2000; // a tree is for navigating, not for dumping a vendored monorepo
const MAX_FS_FILE_BYTES = 262144; // 256 KiB — a workbench shows a file, it does not download one
const MAX_FS_DIFF_BYTES = 65536;

// Repo-RELATIVE paths only — traversal, absolute paths and control characters are a client bug, refused before
// any shell sees them (the command additionally ships the path as quoted shell data).
export function validRepoPath(path: string): boolean {
  if (path === "" || path.length > 1024) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (path.startsWith("/") || /[\x00-\x1f]/.test(path)) return false;
  return !path.split("/").some((segment) => segment === "..");
}

// List tracked+untracked files plus the working-tree status in one shell round-trip. Exit 43 = not a git
// worktree (non-repo env kinds) — the caller reads that as "no tree", never an error.
export function fsTreeCommand(): string {
  return `${FS_ENTER_REPO}git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 43; git ls-files --cached --others --exclude-standard && printf '\\n${FS_SENTINEL}\\n' && git status --porcelain`;
}

// Read one file (base64 so binary/UTF-8 survives the stdout transport) + its working-tree diff. Exit 44 = no
// such file. The path travels as POSIX single-quoted shell DATA, never syntax (validRepoPath refused traversal).
export function fsFileCommand(path: string): string {
  const quoted = `'${path.replace(/'/g, "'\\''")}'`;
  return (
    `${FS_ENTER_REPO}f=${quoted}; [ -f "$f" ] || exit 44; wc -c < "$f"; printf '${FS_SENTINEL}\\n'; ` +
    `head -c ${MAX_FS_FILE_BYTES} "$f" | base64; printf '\\n${FS_DIFF_SENTINEL}\\n'; ` +
    `git diff HEAD -- "$f" 2>/dev/null | head -c ${MAX_FS_DIFF_BYTES}`
  );
}

// git quotes unusual paths C-style ("a\tb"); the quoted form is valid JSON, so borrow its parser (best-effort).
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw;
  }
}

type FsStatus = NonNullable<CaseFsTreePayload["files"][number]["status"]>;

export function parseFsTree(stdout: string): CaseFsTreePayload {
  const at = stdout.indexOf(FS_SENTINEL);
  const listPart = at >= 0 ? stdout.slice(0, at) : stdout;
  const statusPart = at >= 0 ? stdout.slice(at + FS_SENTINEL.length) : "";
  const statusByPath = new Map<string, FsStatus>();
  for (const line of statusPart.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(" -> "); // a staged rename reports "old -> new" — the file explorer badges the new
    if (arrow >= 0) path = path.slice(arrow + 4);
    const status: FsStatus =
      code === "??" || code.includes("A") ? "added" : code.includes("D") ? "deleted" : "modified";
    statusByPath.set(unquoteGitPath(path), status);
  }
  const seen = new Set<string>();
  for (const line of listPart.split("\n")) {
    if (line !== "") seen.add(unquoteGitPath(line));
  }
  // A staged delete already left the index — merge status-only paths so the explorer still shows the tombstone.
  for (const path of statusByPath.keys()) seen.add(path);
  const paths = [...seen].sort();
  const truncated = paths.length > MAX_FS_ENTRIES;
  const files = paths.slice(0, MAX_FS_ENTRIES).map((path) => {
    const status = statusByPath.get(path);
    return status ? { path, status } : { path };
  });
  return { files, truncated };
}

export function parseFsFile(path: string, stdout: string): CaseFsFilePayload | undefined {
  const contentAt = stdout.indexOf(`${FS_SENTINEL}\n`);
  const diffAt = stdout.indexOf(`${FS_DIFF_SENTINEL}\n`);
  if (contentAt < 0 || diffAt < contentAt) return undefined;
  const size = Number.parseInt(stdout.slice(0, contentAt).trim(), 10);
  if (!Number.isFinite(size)) return undefined;
  const b64 = stdout.slice(contentAt + FS_SENTINEL.length + 1, diffAt).replace(/\s+/g, "");
  const bytes = Buffer.from(b64, "base64");
  const binary = bytes.includes(0);
  const diff = stdout.slice(diffAt + FS_DIFF_SENTINEL.length + 1);
  return {
    path,
    size,
    binary,
    truncated: size > MAX_FS_FILE_BYTES,
    content: binary ? "" : bytes.toString("utf8"),
    diff: diff.trim() === "" ? "" : diff,
  };
}
