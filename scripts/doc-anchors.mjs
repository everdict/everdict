// The doc-anchors rule, as pure functions `scripts/check-doc-anchors.mjs` consumes — kept apart so the rule
// is driven over a truth table before it is asked about real history.
//
// ── A DECLARATION WITH NO READER ─────────────────────────────────────────────────────────────────────
//
// `anchors:` in a document's frontmatter names the source files whose change should force a review of that
// page. Until 2026-09-15 the only thing that read it was `pnpm docs-check`, which asked whether each anchored
// path EXISTS — so 106 documents declared "look at me when this file changes" and nothing ever looked. That
// is the defect this repository names most often, wearing a documentation costume. It showed: in the month
// before this rule, 467 commits changed `packages/` or `apps/` and the user guide was edited three times,
// never alongside code.
//
// The rule, over a push: when the range changes a file some document anchors, and the range does not change
// that document, a commit in the range must say so — per document, with a reason:
//
//     Docs-unchanged: docs/scorecards.md, docs/guide/concepts/scorecard.md — only the log wording moved
//
// Per document rather than a blanket `Docs: unchanged`, because the value of the question is that the author
// reads the list; a blanket line is the answer that lets them not. Per PUSH rather than per commit, because a
// document updated in the last commit of a push was updated with the change — bisecting does not care about
// prose.
//
// Out of scope: records under `docs/sdlc/` (their shape is another gate's), superseded decisions (their
// successor is the live answer), and the frozen re-architecture folder (historical by declaration).
//
// ── ASKED vs ADVISORY — MEASURED BEFORE IT WAS WIRED ────────────────────────────────────────────────
//
// Replayed over the 599 code commits of the month before this rule, with every anchor narrowed to the file
// that defines the documented surface: pages people FOLLOW — the guide, the reference pages at the docs root,
// runbooks, migration preflights — would have been owed on 23.7% of commits (median 7 pages a day). The
// architecture design records would have been owed on 43.9%, because they anchor the central contract schemas
// (`eval-case.ts` alone changed 96 times) and most of those changes do not touch what a design record argues.
// A gate that asks on nearly half of all commits gets a rote answer, and a rote answer is no answer. So the
// followed pages are ASKED (a violation until edited or declined) and the design records are ADVISORY: listed,
// never refused, and read by the documentation pass in `REVIEW.md`. A design record is still owned by the change
// that makes it false; what it does not get is a gate, because the measurement says the gate would not hold.

const DECLARATION = /^Docs-unchanged:\s*(\S[^\n]*?)\s+[—-]\s+(\S.*)$/gm;
const EXEMPT = [/^docs\/sdlc\//, /^docs\/architecture\/rearchitecture\//];
const ADVISORY = [/^docs\/architecture\//];

/** Frontmatter `anchors:` of one document body, or [] when it declares none. */
export function anchorsOf(body) {
  const lines = body.split("\n");
  if (lines[0] !== "---") return [];
  const end = lines.indexOf("---", 1);
  if (end < 0) return [];
  const header = lines.slice(1, end);
  if (header.some((line) => /^status:\s*superseded\s*$/.test(line))) return [];
  const line = header.find((l) => l.startsWith("anchors:"));
  if (line === undefined) return [];
  return line
    .slice("anchors:".length)
    .replace(/^\s*\[|\]\s*$/g, "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

/** Every `Docs-unchanged:` declaration across commit bodies: doc path → reason. A reasonless line is not one. */
export function declaredUnchanged(bodies) {
  const declared = new Map();
  for (const body of bodies) {
    for (const m of body.matchAll(DECLARATION)) {
      for (const doc of m[1]
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean))
        declared.set(doc, m[2].trim());
    }
  }
  return declared;
}

/**
 * @param {{ changed: string[], bodies: string[], docs: Map<string, string[]> }} range
 *   `changed` — every path the push range touches; `bodies` — every commit body in it;
 *   `docs` — document path → its anchors, as of the tip.
 * @returns {{ owed: { doc: string, anchors: string[] }[], advisory: { doc: string, anchors: string[] }[],
 *   declined: { doc: string, why: string }[], stale: string[] }}
 *   `owed` — an ASKED page implicated and neither edited nor declared (a violation); `advisory` — the same for a
 *   design record, listed and never refused; `declined` — declared, with the reason; `stale` — declared for a
 *   document this range does not implicate (a reason that outlived its subject).
 */
export function verdictFor({ changed, bodies, docs }) {
  const touched = new Set(changed);
  const declared = declaredUnchanged(bodies);
  const owed = [];
  const advisory = [];
  const declined = [];
  const implicated = new Set();
  for (const [doc, anchors] of docs) {
    if (EXEMPT.some((pattern) => pattern.test(doc))) continue;
    const hit = anchors.filter((a) => touched.has(a));
    if (hit.length === 0 || touched.has(doc)) continue;
    implicated.add(doc);
    const why = declared.get(doc);
    if (why !== undefined) declined.push({ doc, why });
    else if (ADVISORY.some((pattern) => pattern.test(doc))) advisory.push({ doc, anchors: hit });
    else owed.push({ doc, anchors: hit });
  }
  const stale = [...declared.keys()].filter((doc) => !implicated.has(doc));
  return { owed, advisory, declined, stale };
}
