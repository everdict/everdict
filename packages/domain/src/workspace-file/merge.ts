import type { FsMergeConflict, FsMergeResult } from "@everdict/contracts";

// Three-way text merge for the workspace filesystem — the rule that lets two authors (a member and an agent, or
// two members) edit one file at the same time without either silently winning. Given the common ancestor both
// started from, only the hunks BOTH sides rewrote are true conflicts; everything else reconciles automatically.
//
// Line-based on purpose: workspace files are markdown/CSV/JSON/code written by people and agents, where a line is
// the unit an author actually thinks in, and a line-based merge produces a result a human can still read and fix.
// (No rename/move detection, no word-level fallback — those buy little on this content and cost a lot of subtlety.)

const CONFLICT_HEAD = "<<<<<<< yours";
const CONFLICT_SPLIT = "=======";
const CONFLICT_TAIL = ">>>>>>> published";

// Split keeping the document reconstructible: "a\nb" → ["a","b"], "a\n" → ["a",""] so a trailing newline survives.
function toLines(text: string): string[] {
  return text.split("\n");
}

// Longest common subsequence of two line arrays, as index pairs. O(n·m) — bounded by the filesystem's own 5 MiB
// cap and only ever reached on an actual conflict, so the simple table beats a cleverer diff here.
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i…] and b[j…]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i];
      const next = table[i + 1];
      if (!row || !next) continue;
      const nextRow = next[j];
      const sameRow = row[j + 1];
      if (nextRow === undefined || sameRow === undefined) continue;
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(nextRow, sameRow);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
      continue;
    }
    const down = table[i + 1]?.[j] ?? 0;
    const right = table[i]?.[j + 1] ?? 0;
    if (down >= right) i++;
    else j++;
  }
  return pairs;
}

// One CHANGE a side made, in base coordinates: base[bStart, bEnd) became side[sStart, sEnd). Chunking the merge by
// changes — rather than by lines all three happen to agree on — is what lets two authors edit ADJACENT lines
// without a conflict: the changes never overlap, so each applies on its own (the behaviour git users expect).
interface Hunk {
  bStart: number;
  bEnd: number;
  sStart: number;
  sEnd: number;
}

function hunksOf(base: readonly string[], side: readonly string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let b = 0;
  let s = 0;
  for (const [pb, ps] of lcsPairs(base, side)) {
    if (pb > b || ps > s) hunks.push({ bStart: b, bEnd: pb, sStart: s, sEnd: ps });
    b = pb + 1;
    s = ps + 1;
  }
  if (b < base.length || s < side.length) {
    hunks.push({ bStart: b, bEnd: base.length, sStart: s, sEnd: side.length });
  }
  return hunks;
}

// Two changes clash when their base ranges overlap — plus the degenerate case of both sides INSERTING at the same
// point (empty base range), where there is no honest way to order the two insertions.
function clashes(a: Hunk, b: Hunk): boolean {
  if (a.bStart < b.bEnd && b.bStart < a.bEnd) return true;
  return a.bStart === b.bStart && (a.bStart === a.bEnd || b.bStart === b.bEnd);
}

// What a side reads across a base range: its own text where it changed something, the base's where it did not.
function sideText(
  base: readonly string[],
  side: readonly string[],
  hunks: readonly Hunk[],
  from: number,
  to: number,
): string[] {
  const out: string[] = [];
  let b = from;
  for (const h of hunks) {
    if (h.bEnd < from || h.bStart > to) continue;
    if (h.bStart > b) out.push(...base.slice(b, h.bStart));
    out.push(...side.slice(h.sStart, h.sEnd));
    b = h.bEnd;
  }
  if (b < to) out.push(...base.slice(b, to));
  return out;
}

const sameText = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, i) => line === b[i]);

// Reconcile `ours` (the incoming write) and `theirs` (what got published meanwhile) over their common `base`.
// Returns a COMPLETE document either way: `conflicts` empty means it is safe to publish as-is; otherwise the
// conflicting hunks are marked inline and also reported structurally so a UI can offer a side-by-side choice.
export function mergeThreeWay(base: string, ours: string, theirs: string): FsMergeResult {
  if (ours === theirs) return { merged: ours, conflicts: [] };
  if (base === ours) return { merged: theirs, conflicts: [] }; // we changed nothing
  if (base === theirs) return { merged: ours, conflicts: [] }; // nobody published over us after all

  const baseLines = toLines(base);
  const ourLines = toLines(ours);
  const theirLines = toLines(theirs);
  const ourHunks = hunksOf(baseLines, ourLines);
  const theirHunks = hunksOf(baseLines, theirLines);

  const merged: string[] = [];
  const conflicts: FsMergeConflict[] = [];
  let b = 0; // how far through the base we have emitted
  let oi = 0;
  let ti = 0;

  while (oi < ourHunks.length || ti < theirHunks.length) {
    const nextOur = ourHunks[oi];
    const nextTheir = theirHunks[ti];
    // Take the earliest change; then absorb every change from EITHER side that clashes with the group so far, so
    // an overlapping tangle is decided once instead of being interleaved into nonsense.
    let start = Math.min(nextOur?.bStart ?? Number.POSITIVE_INFINITY, nextTheir?.bStart ?? Number.POSITIVE_INFINITY);
    let end = start;
    const group = { ours: [] as Hunk[], theirs: [] as Hunk[] };
    let grew = true;
    while (grew) {
      grew = false;
      const window: Hunk = { bStart: start, bEnd: end, sStart: 0, sEnd: 0 };
      while (oi < ourHunks.length) {
        const h = ourHunks[oi];
        if (!h) break;
        if (group.ours.length === 0 && group.theirs.length === 0 ? h.bStart === start : clashes(h, window)) {
          group.ours.push(h);
          start = Math.min(start, h.bStart);
          end = Math.max(end, h.bEnd);
          oi++;
          grew = true;
        } else break;
      }
      while (ti < theirHunks.length) {
        const h = theirHunks[ti];
        if (!h) break;
        if (
          group.ours.length === 0 && group.theirs.length === 0
            ? h.bStart === start
            : clashes(h, { ...window, bEnd: end })
        ) {
          group.theirs.push(h);
          start = Math.min(start, h.bStart);
          end = Math.max(end, h.bEnd);
          ti++;
          grew = true;
        } else break;
      }
    }

    merged.push(...baseLines.slice(b, start)); // untouched base before this change
    const ourSlice = sideText(baseLines, ourLines, group.ours, start, end);
    const theirSlice = sideText(baseLines, theirLines, group.theirs, start, end);
    if (group.theirs.length === 0) merged.push(...ourSlice);
    else if (group.ours.length === 0) merged.push(...theirSlice);
    else if (sameText(ourSlice, theirSlice))
      merged.push(...ourSlice); // both made the SAME edit
    else {
      conflicts.push({
        line: merged.length,
        base: baseLines.slice(start, end).join("\n"),
        ours: ourSlice.join("\n"),
        theirs: theirSlice.join("\n"),
      });
      merged.push(CONFLICT_HEAD, ...ourSlice, CONFLICT_SPLIT, ...theirSlice, CONFLICT_TAIL);
    }
    b = end;
  }
  merged.push(...baseLines.slice(b));
  return { merged: merged.join("\n"), conflicts };
}
