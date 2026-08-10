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

import { execSync } from "node:child_process";
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
  for (const doc of docs) {
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

  for (const { doc, token } of sites) {
    if (ignored.has(token)) continue;
    failures.push(`${doc} cites \`${token}\`, which is not in the repository`);
  }
}

if (failures.length) {
  console.error(`docs check FAILED — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nSee docs/architecture/docs-site.md for what this gate is protecting.");
  process.exit(1);
}
console.log(`docs check OK — ${docs.length} documents: indexed, links resolve, cited code paths exist.`);
