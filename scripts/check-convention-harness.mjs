#!/usr/bin/env node
// Convention-harness guard — the rules must be able to FIRE.
//
// `.claude/rules/*.md` are the PUSH layer: a rule is auto-injected when a file matching its frontmatter
// `paths:` glob is read or edited. A rule whose glob matches nothing is not a weak rule, it is an ABSENT one —
// and absent silently, which is the same failure mode this repo keeps paying for one level up (a green suite
// over the gap it was written to close).
//
// This is not hypothetical: `suite.md` carried 10 KB of scoring/settlement rules pointed at `packages/suite/**`,
// a package the re-architecture folded into the spine. It fired for nobody, for months, and the invariants it
// states are exactly the ones later reviews found broken.
//
// It enforces four things, cheaply and with no dependencies:
//   (1) every rule has frontmatter with a `paths:` glob — a rule with none is always-on by accident, not design
//   (2) every glob segment matches at least one real path in the repo
//   (3) every rule referenced from CLAUDE.md / .claude/skills/README.md exists
//   (4) every skill directory has a SKILL.md with `name:` + `description:` frontmatter (the PULL layer is
//       matched on the description, so a missing one is a skill the model can never select)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rulesDir = path.join(root, ".claude", "rules");
const skillsDir = path.join(root, ".claude", "skills");
const problems = [];

// ── glob matching ───────────────────────────────────────────────────────────────────────────────────
// The globs in use are simple: `**/*`, `**/*.ts`, `apps/api/**`, `packages/{a,b}/**`, and comma-separated
// lists of literal file paths. Expand braces, then test candidate paths against a regex translation.
function expandBraces(glob) {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  return m[1]
    .split(",")
    .flatMap((option) => expandBraces(glob.slice(0, m.index) + option.trim() + glob.slice(m.index + m[0].length)));
}

// A `paths:` value is a comma-separated LIST of globs, and a glob may itself contain a brace list whose
// options are comma-separated. Split only on the commas OUTSIDE braces, or `packages/{contracts,domain}/**`
// is shredded into two globs that match nothing — the exact false alarm this guard must not raise.
function splitTopLevel(value) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const c of value) {
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero directories
      } else out += "[^/]*";
      continue;
    }
    out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${out}$`);
}

const SKIP = new Set(["node_modules", ".git", "dist", ".next", ".turbo", "coverage", ".venv"]);
function collectPaths(dir, prefix, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      out.push(`${rel}/`);
      collectPaths(full, rel, out);
    } else out.push(rel);
  }
  return out;
}
const repoPaths = collectPaths(root, "", []);

// ── (1) + (2) rules have a paths glob, and it matches something ─────────────────────────────────────
const ruleFiles = existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith(".md")) : [];
if (ruleFiles.length === 0) problems.push(".claude/rules holds no rules — the push layer is gone");

for (const file of ruleFiles) {
  const source = readFileSync(path.join(rulesDir, file), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!frontmatter) {
    problems.push(
      `.claude/rules/${file} has no frontmatter — add \`paths:\` naming the files it governs (a rule with no scope fires everywhere by accident, and the always-on budget is what makes the scoped ones readable)`,
    );
    continue;
  }
  const declared = /^paths:\s*"([^"]+)"\s*$/m.exec(frontmatter[1]);
  if (!declared) {
    problems.push(`.claude/rules/${file} frontmatter declares no \`paths:\` glob`);
    continue;
  }
  for (const segment of splitTopLevel(declared[1])) {
    const glob = segment.trim();
    if (glob === "") continue;
    const matched = expandBraces(glob).some((expanded) => {
      const re = globToRegExp(expanded.endsWith("/**") ? `${expanded.slice(0, -3)}/**/*` : expanded);
      return repoPaths.some((p) => re.test(p) || re.test(p.replace(/\/$/, "")));
    });
    if (!matched)
      problems.push(
        `.claude/rules/${file} is pointed at '${glob}', which matches nothing in the repo — this rule can never fire. Re-point it at the code that moved, or delete it.`,
      );
  }
}

// ── (3) every referenced rule exists ────────────────────────────────────────────────────────────────
const known = new Set(ruleFiles.map((f) => f.replace(/\.md$/, "")));
for (const doc of ["CLAUDE.md", path.join(".claude", "skills", "README.md")]) {
  const full = path.join(root, doc);
  if (!existsSync(full)) continue;
  const source = readFileSync(full, "utf8");
  for (const m of source.matchAll(/(?:rule|rules)\s+[`"]([a-z0-9-]+)[`"]/g))
    if (!known.has(m[1])) problems.push(`${doc} points at rule \`${m[1]}\`, which does not exist in .claude/rules`);
}

// ── (4) every skill is selectable ───────────────────────────────────────────────────────────────────
for (const entry of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
  const dir = path.join(skillsDir, entry);
  if (!statSync(dir).isDirectory()) continue;
  const skill = path.join(dir, "SKILL.md");
  if (!existsSync(skill)) {
    problems.push(`.claude/skills/${entry} has no SKILL.md — the pull layer cannot offer it`);
    continue;
  }
  const source = readFileSync(skill, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!frontmatter || !/^name:\s*\S/m.test(frontmatter[1]) || !/^description:\s*\S/m.test(frontmatter[1]))
    problems.push(
      `.claude/skills/${entry}/SKILL.md needs frontmatter with \`name:\` and \`description:\` — the description is what the model matches on, so without it the skill is unreachable`,
    );
}

// ── (5) every workspace is GOVERNED — the map has no blank regions ──────────────────────────────────
//
// (2) proves each rule reaches live code. It says nothing about the other direction: a package nobody wrote a
// rule for is a package Claude Code edits with no conventions injected at all, and that absence is invisible
// — no check fails, no rule looks wrong, the model simply works without the constraints the rest of the repo
// has. Six packages were in that state when this check was written.
//
// GOVERNED means some rule's `paths:` glob covers the workspace, OR a skill names it. A skill is enough
// because the pull layer is how a model reaches deep guidance; what is not enough is nothing.
const workspaces = [];
for (const group of ["packages", "apps"]) {
  const dir = path.join(root, group);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir))
    if (statSync(path.join(dir, name)).isDirectory()) workspaces.push(`${group}/${name}`);
}
// The always-on rules (`**/*`, `**/*.ts`, `**/*.test.ts`) cover every workspace by construction, which is
// exactly why they cannot answer this question: counting them would make the check vacuously green over the
// blank regions it exists to find. Coverage means a rule that chose this code.
const REPO_WIDE = new Set(["**/*", "**/*.ts", "**/*.test.ts"]);
const ruleGlobs = ruleFiles.flatMap((file) => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path.join(rulesDir, file), "utf8"));
  const declared = frontmatter && /^paths:\s*"([^"]+)"\s*$/m.exec(frontmatter[1]);
  if (!declared) return [];
  return splitTopLevel(declared[1])
    .map((seg) => seg.trim())
    .filter((seg) => !REPO_WIDE.has(seg))
    .flatMap((seg) => expandBraces(seg));
});
const skillText = (existsSync(skillsDir) ? readdirSync(skillsDir) : [])
  .map((entry) => path.join(skillsDir, entry, "SKILL.md"))
  .filter((f) => existsSync(f))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
for (const workspace of workspaces) {
  const probe = `${workspace}/src/index.ts`;
  const covered = ruleGlobs.some((glob) => {
    const re = globToRegExp(glob.endsWith("/**") ? `${glob.slice(0, -3)}/**/*` : glob);
    return re.test(probe) || re.test(workspace);
  });
  if (covered) continue;
  const named = skillText.includes(workspace) || skillText.includes(`@everdict/${workspace.split("/")[1]}`);
  if (!named)
    problems.push(
      `${workspace} is governed by no rule and named by no skill — an unmapped workspace is edited with no conventions injected, and nothing else in this repo notices. Point an existing rule's \`paths:\` at it, or give it one.`,
    );
}

if (problems.length > 0) {
  console.error("✖ convention harness — a rule or skill cannot reach the code it governs:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nA convention that cannot fire is not a weak convention, it is an absent one. See .claude/skills/README.md.",
  );
  process.exit(1);
}
console.log(`✓ convention harness — ${ruleFiles.length} rules all reach live paths; every skill is selectable`);
