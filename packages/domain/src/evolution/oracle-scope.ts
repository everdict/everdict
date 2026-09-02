// ── THE ORACLE IS A SET OF PATHS, AND THE CANDIDATE MAY NOT TOUCH THEM (code-evolution-loop.md, D3) ──
//
// A coding agent with a repository checkout can edit the dataset, the judge rubric or the graders' tests as
// easily as the scaffold — and any of those is the candidate rewriting its own exam. The frame freezes the
// boundary as repository path PATTERNS; this is the one matcher both the round verdict and any later reader
// consume, so "did the pull request touch the oracle" has one spelling (rule `protocol` L3).
//
// Pattern language, deliberately small and stated here rather than borrowed from a globbing library nobody
// else in the tree depends on:
//   `*`   any run of characters within ONE path segment
//   `?`   one character within a segment
//   `**`  any number of segments, including none (`evals/**` covers `evals/x` and `evals/a/b/x`)
//   a pattern ending in `/` names a directory and everything beneath it (`tests/` ≡ `tests/**`)
//   a pattern with no wildcard names one path exactly, or a directory and everything beneath it
// Paths are compared as the repository reports them: forward slashes, relative to the repository root. A
// leading `./` or `/` on either side is ignored so a hand-written pattern and GitHub's listing agree.

function normalizePath(path: string): string {
  let p = path.trim().replaceAll("\\", "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  return p;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

const hasWildcard = (pattern: string): boolean => /[*?]/.test(pattern);

function patternToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` swallows whole segments (or nothing); a bare `**` at the end matches the rest.
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch !== undefined) {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`);
}

// Does one repository path fall inside one pattern?
export function pathMatchesPattern(path: string, pattern: string): boolean {
  const p = normalizePath(path);
  let pat = normalizePath(pattern);
  if (pat === "") return false;
  if (pat.endsWith("/")) pat = `${pat}**`;
  if (!hasWildcard(pat)) return p === pat || p.startsWith(`${pat}/`);
  return patternToRegExp(pat).test(p);
}

// The paths, among those a change touched, that fall inside the oracle — sorted and unique, so a verdict
// detail reads the same whatever order the listing came in. Empty = the change stayed off the exam.
export function oracleTouched(changedPaths: readonly string[], scope: readonly string[]): string[] {
  if (scope.length === 0) return [];
  const hits = new Set<string>();
  for (const path of changedPaths)
    if (scope.some((pattern) => pathMatchesPattern(path, pattern))) hits.add(normalizePath(path));
  return [...hits].sort();
}
