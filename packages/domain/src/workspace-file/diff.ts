import type { FsTextDiff, FsTextDiffHunk, FsTextDiffLine } from "@everdict/contracts";
import { fileLineMatches, splitFileLines } from "./merge.js";

// Line diff between two revisions of one workspace file — "what changed between rev 3 and now", the question the
// history panel exists to answer. Shares the merge's LCS so a diff and a merge can never disagree about what
// counts as a change.
//
// The result is HUNKS with context rather than the whole document: a member comparing two revisions of a long
// report wants the edited passages, not to scroll a thousand unchanged lines looking for them.

const CONTEXT_LINES = 3;

// Cap the work an unbounded comparison can do. The LCS table is O(n·m) — two 40k-line files would allocate 1.6B
// cells. Beyond the cap we report the fact instead of hanging the request, and the caller still has both
// contents to fall back on.
const MAX_DIFF_LINES = 20_000;

export function diffFileText(before: string, after: string): FsTextDiff {
  if (before === after) return { hunks: [], added: 0, removed: 0, truncated: false };

  const a = splitFileLines(before);
  const b = splitFileLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { hunks: [], added: 0, removed: 0, truncated: true };
  }

  // Walk both sides against the matched pairs: every gap is a removal run followed by an addition run.
  const lines: FsTextDiffLine[] = [];
  let ai = 0;
  let bi = 0;
  let added = 0;
  let removed = 0;
  const emitGap = (aEnd: number, bEnd: number): void => {
    for (; ai < aEnd; ai++) {
      lines.push({ op: "remove", text: a[ai] ?? "", beforeLine: ai + 1 });
      removed++;
    }
    for (; bi < bEnd; bi++) {
      lines.push({ op: "add", text: b[bi] ?? "", afterLine: bi + 1 });
      added++;
    }
  };
  for (const [pa, pb] of fileLineMatches(a, b)) {
    emitGap(pa, pb);
    lines.push({ op: "context", text: a[pa] ?? "", beforeLine: pa + 1, afterLine: pb + 1 });
    ai = pa + 1;
    bi = pb + 1;
  }
  emitGap(a.length, b.length);

  return { hunks: toHunks(lines), added, removed, truncated: false };
}

// Group changed lines into hunks, keeping CONTEXT_LINES of unchanged text around each run and dropping the rest.
function toHunks(lines: readonly FsTextDiffLine[]): FsTextDiffHunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (const [i, line] of lines.entries()) {
    if (line.op === "context") continue;
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++) {
      keep[j] = true;
    }
  }

  const hunks: FsTextDiffHunk[] = [];
  let current: FsTextDiffLine[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0];
    hunks.push({
      beforeStart: firstLineNumber(current, "beforeLine") ?? first?.beforeLine ?? 0,
      afterStart: firstLineNumber(current, "afterLine") ?? first?.afterLine ?? 0,
      lines: current,
    });
    current = [];
  };
  for (const [i, line] of lines.entries()) {
    if (keep[i]) current.push(line);
    else flush();
  }
  flush();
  return hunks;
}

function firstLineNumber(lines: readonly FsTextDiffLine[], key: "beforeLine" | "afterLine"): number | undefined {
  for (const line of lines) {
    const value = line[key];
    if (value !== undefined) return value;
  }
  return undefined;
}
