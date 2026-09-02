#!/usr/bin/env node
// Documentation integrity gate — the mechanical half of "docs travel with the code".
//
// Three checks, all of which have caught real rot in this tree:
//   1. INDEX      every docs/**/*.md is reachable from docs/README.md (77 files were orphaned once)
//   2. LINKS      every relative markdown link resolves, and points at a FILE (a directory link works
//                 on github.com but has no route on the docs site)
//   3. CODE REFS  every `packages/...` / `apps/...` path cited in backticks still exists (the
//                 re-architecture left 163 dead ones behind)
//
// docs/architecture/rearchitecture/** is exempt from check 3 on purpose: those are historical review
// artifacts, and the pre-migration paths they cite are the record, not a mistake.
//
// Run: node scripts/check-docs.mjs

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const INDEX = "docs/README.md";
const HISTORICAL = "docs/architecture/rearchitecture/";

const walk = (dir, out = []) => {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (entry.endsWith(".md")) out.push(rel);
  }
  return out;
};

const docs = walk("docs").sort();

// The rules and skills are documentation the MODEL reads, not the human — the push layer is injected into
// context by a `paths:` glob, so a rule citing a moved file teaches the wrong address at the moment of
// editing, with nobody reading it deliberately enough to notice. `pnpm convention-harness` checks that
// layer's STRUCTURE (every rule reaches live paths, every workspace is governed); what it cannot see is a
// path that still exists beside a symbol that does not. So check 3 — "cited code paths still exist" — runs
// over both bodies of text from one predicate. Checks 1 and 2 stay docs-only: `.claude/**` has its own
// index (`.claude/skills/README.md`, guarded by the convention harness) and does not link relatively.
const conventions = [...walk(".claude/rules"), ...walk(".claude/skills")].sort();
const citing = [...docs, ...conventions];
const failures = [];

// ── 1. index completeness ───────────────────────────────────────────────────────────────────────
{
  const index = readFileSync(join(ROOT, INDEX), "utf8");
  const linked = new Set(
    [...index.matchAll(/\]\(([^)#]+)/g)]
      .map((m) => m[1])
      .filter((href) => !/^(https?|mailto):/.test(href))
      .map((href) => (href.startsWith("../") ? href.slice(3) : `docs/${href.replace(/^\.\//, "")}`)),
  );
  for (const doc of docs) {
    if (doc === INDEX || linked.has(doc)) continue;
    failures.push(`${INDEX} does not link ${doc} — every document belongs in the index`);
  }
}

// ── 2. relative links resolve, and resolve to files ─────────────────────────────────────────────
for (const doc of docs) {
  const text = readFileSync(join(ROOT, doc), "utf8");
  for (const m of text.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
    const href = m[1];
    if (/^(https?|mailto):/.test(href)) continue;
    const target = href.startsWith("/") ? href.slice(1) : join(dirname(doc), href);
    if (!existsSync(join(ROOT, target))) {
      failures.push(`${doc} links to ${href}, which does not exist`);
      continue;
    }
    if (statSync(join(ROOT, target)).isDirectory())
      failures.push(`${doc} links to the directory ${href} — link a file; a directory has no page on the site`);
    if (!target.startsWith("docs/"))
      failures.push(`${doc} links outside docs/ (${href}) — use an absolute github.com URL instead`);
  }
}

// ── 3. cited code paths still exist ─────────────────────────────────────────────────────────────
{
  // Tracked AND new-but-not-ignored: a doc committed alongside the file it cites must pass in the
  // same working tree, and `--exclude-standard` keeps gitignored paths (`.env`, build output) out.
  const tracked = new Set(
    execSync("git ls-files --cached --others --exclude-standard", { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString()
      .split("\n")
      .filter(Boolean),
  );
  const dirs = new Set();
  for (const f of tracked) {
    let d = dirname(f);
    while (d && d !== ".") {
      dirs.add(d);
      dirs.add(`${d}/`);
      d = dirname(d);
    }
  }
  const isRepoPath = (s) => /^(packages|apps|scripts|deploy|examples|clients|plugin|e2e|\.github|\.claude)\//.test(s);

  // Paths that are absent ON PURPOSE. Each needs a reason: the point of the gate is that "missing" is
  // a decision someone made, not a thing that drifted. A path leaves this list when its reason expires.
  const KNOWN_ABSENT = new Map([
    // Generated into the USER's repository by the CI setup-PR flow, never present in ours.
    [".github/workflows/everdict-eval.yml", "generated into the user repo by POST /workspace/ci/links/setup-pr"],
    // Removed with the `docker` runtime kind in slice 5b; the prose around it says so and cites 038c31d.
    ["examples/runtimes/docker-1.0.0.json", "removed with the docker runtime kind (slice 5b, 038c31d)"],
    // Lives in the aegra repository, not this one — the paragraph is instructions for setting aegra up.
    ["examples/browser_agent/", "a path inside aegra's repository, not everdict's"],
    // Dropped with the Connected-accounts feature by migration 0046; the page carries a SUPERSEDED banner.
    ["packages/db/src/connection-store.test.ts", "dropped with everdict_connections (migration 0046)"],
    ["apps/api/src/connection-service.test.ts", "dropped with everdict_connections (migration 0046)"],
    // The pre-re-architecture package, named in prose that explains where its contents went.
    ["packages/core", "the pre-re-architecture package, cited historically"],
  ]);

  // `.env` and friends are gitignored by design — the docs tell you to create them.
  const candidates = new Set();
  const sites = [];
  for (const doc of citing) {
    if (doc.startsWith(HISTORICAL)) continue;
    const text = readFileSync(join(ROOT, doc), "utf8");
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      let token = m[1].trim().replace(/[).,;:]+$/, "");
      token = token.replace(/:[\d,\-+]+$/, ""); // strip `file.ts:12,40-52` line refs
      if (!isRepoPath(token) || /[*?{}<>|\s]/.test(token)) continue;
      if (tracked.has(token) || dirs.has(token) || KNOWN_ABSENT.has(token)) continue;
      candidates.add(token);
      sites.push({ doc, token });
    }
  }

  let ignored = new Set();
  if (candidates.size) {
    const res = execSync("git check-ignore --stdin --no-index || true", {
      cwd: ROOT,
      input: [...candidates].join("\n"),
      encoding: "utf8",
    });
    ignored = new Set(res.split("\n").filter(Boolean));
  }

  // ── 4b. AN ANCHOR NAMES CODE THAT MUST STILL EXIST ────────────────────────────────────────────────
  //
  // `anchors:` in a doc's frontmatter names the source files whose change should force a review of that
  // page. Its whole value is that a stale one is LOUD — so it has to be checked, or it is a declaration
  // nobody consumes, which is this repository's most-repeated defect wearing a documentation costume.
  //
  // Scanned separately from the backtick pass because frontmatter is not prose: these paths are bare, and
  // the reader of a doc never sees them. Nothing else would ever notice them going dead.
  for (const doc of docs) {
    const head = readFileSync(join(ROOT, doc), "utf8").split("\n---", 2);
    if (!head[0].startsWith("---")) continue;
    const line = head[0].split("\n").find((l) => l.startsWith("anchors:"));
    if (line === undefined) continue;
    for (const raw of line
      .slice("anchors:".length)
      .replace(/^\s*\[|\]\s*$/g, "")
      .split(",")) {
      const anchorPath = raw.trim();
      if (anchorPath === "") continue;
      if (!tracked.has(anchorPath))
        failures.push(
          `${doc} anchors ${anchorPath}, which is not in the repository — the doc lost touch with the code it describes`,
        );
    }
  }

  for (const { doc, token } of sites) {
    if (ignored.has(token)) continue;
    failures.push(`${doc} cites \`${token}\`, which is not in the repository`);
  }
}

// ── 4. symbols the CONVENTION layer names still exist ───────────────────────────────────────────
// Scoped to `.claude/**` on purpose. A path that moved is caught by check 3; a path that stayed while the
// SYMBOL inside it was deleted is not, and that is the shape that actually rots here: the backends rule
// taught `Recoverable`/`isObservable` for two review cycles after arch-review 53 deleted the case-id control
// surface, because `packages/backends/src/backend.ts` still existed. Docs are read deliberately by a human
// who can notice; a rule is injected by a glob at the moment of editing and read by a model that cannot.
// It is also a difference in KIND: a design record under `docs/architecture/` is allowed to name a type it
// is proposing — that is what a design record is for, and ~25 of the names `docs/**` uses this way are
// either external API surface (Temporal RPCs, S3 verbs, A2A events) or a shape still being argued about.
// A rule may not: it describes what to do RIGHT NOW in code that exists.
{
  // A backticked identifier is a claim about this repository. Absences that are deliberate name their reason.
  const KNOWN_ABSENT_SYMBOLS = new Map([
    ["CreateXBodySchema", "a naming TEMPLATE — the X stands for the resource (api-layer recipe)"],
    ["UpdateXBodySchema", "a naming TEMPLATE — the X stands for the resource (api-layer recipe)"],
  ]);

  // ── `git grep` EXITS 1 WHEN IT FINDS NOTHING, AND THAT IS NOT A CRASH (arch-review 120) ─────────────
  //
  // `execSync` throws on any non-zero exit, and "no matches" is git's ordinary way of saying zero. So this
  // check died with a Node stack trace — `Error: Command failed: git grep …`, empty stdout, no diagnostic —
  // instead of reporting anything a reader could act on. It is the shape rule `ci` already records for madge
  // and `import-cycles`: a tool whose exit code IS its answer must have that answer consumed, not thrown.
  //
  // And the empty case is worse than a crash would suggest. If the corpus is genuinely empty, every symbol a
  // rule names resolves against nothing and the check would pass over a repository it never read — a vacuous
  // green, which this file exists to refuse. So zero matches is an explicit FAILURE with its own message,
  // never an exception and never silence.
  //
  // (Seen in the wild: a stray `GIT_INDEX_FILE` pointing at a near-empty index made `git grep` enumerate no
  // tracked files at all. The tree was fine; the checker was not.)
  function symbolsMatching(pathspec) {
    const result = spawnSync("git", ["grep", "-h", "-o", "-E", "\\b[A-Z][A-Za-z0-9]{3,}\\b", "--", ...pathspec], {
      cwd: ROOT,
      maxBuffer: 512 * 1024 * 1024,
      encoding: "utf8",
    });
    if (result.error !== undefined) {
      console.error(`docs check FAILED — could not run git grep: ${result.error.message}`);
      process.exit(1);
    }
    // 0 = matches, 1 = no matches, anything else = git itself failed.
    if (result.status !== 0 && result.status !== 1) {
      console.error(`docs check FAILED — git grep exited ${result.status}: ${(result.stderr ?? "").trim()}`);
      process.exit(1);
    }
    const symbols = (result.stdout ?? "").split("\n").filter(Boolean);
    if (symbols.length === 0) {
      console.error(
        `docs check FAILED — git grep matched NOTHING under ${pathspec.join(" ")}. Every symbol a rule names
  would resolve against an empty corpus, so this check would pass without reading the repository.
  Check for a stray GIT_INDEX_FILE or a checkout with no tracked files there.`,
      );
      process.exit(1);
    }
    return symbols;
  }

  // Test files are EXCLUDED from what counts as live. A deleted interface keeps being named by the ratchet
  // that keeps it deleted — `Recoverable` survives in `legacy-case-addressing-guard.test.ts` precisely
  // BECAUSE it is gone — so counting tests makes this check green over the one defect it was written for.
  // A surface that exists only in a test is not a surface a rule may teach.
  //
  // `scripts/**` is excluded for the same reason one level up: this very file explains the check by NAMING
  // `Recoverable`, and while scripts counted, that sentence was enough to make the mutation pass. A guard
  // whose own prose satisfies it is the failure mode this repo has now shipped three times.
  const live = new Set(symbolsMatching(["packages", "apps", ":(exclude)*.test.ts", ":(exclude)*.test.tsx"]));

  // The testing rule and skill are ABOUT tests, so test files are their live surface: `ControlledBackend` and
  // `InMemoryTransport` are fixtures that exist nowhere else and are exactly what those documents teach.
  // Nothing else may resolve against a test — see the comment on `live`.
  const testOnly = new Set(symbolsMatching(["*.test.ts", "*.test.tsx"]));
  const aboutTests = (doc) => doc === ".claude/rules/testing.md" || doc.startsWith(".claude/skills/testing/");

  for (const doc of conventions) {
    const text = readFileSync(join(ROOT, doc), "utf8");
    for (const m of text.matchAll(/`([A-Z][A-Za-z0-9]{3,})`/g)) {
      const symbol = m[1];
      if (live.has(symbol) || KNOWN_ABSENT_SYMBOLS.has(symbol)) continue;
      if (aboutTests(doc) && testOnly.has(symbol)) continue;
      failures.push(`${doc} names \`${symbol}\`, which no source file declares or uses`);
    }
  }
}

if (failures.length) {
  console.error(`docs check FAILED — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nSee docs/architecture/docs-site.md for what this gate is protecting.");
  process.exit(1);
}
console.log(
  `docs check OK — ${docs.length} documents indexed with resolving links; ` +
    `${citing.length} documents cite only live paths, and ${conventions.length} rules/skills name only live symbols.`,
);
