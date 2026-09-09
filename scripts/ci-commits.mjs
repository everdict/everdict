#!/usr/bin/env node
// Gate every commit a push would carry, not only its tip (arch-review 57 follow-up).
//
// `pnpm ci:local` validates HEAD. A push of eight commits therefore ships seven that were never built, and
// the history advertises itself as bisectable while `git bisect` can land on any of them. That is the worst
// of both arrangements: the cost of a split history without its guarantee.
//
// This walks the commits ahead of the remote and runs the FAST subset on each — lint, typecheck, test. Not
// the full gate, deliberately: gitleaks over all history, the web build and the mutation suite are minutes
// each and answer questions about the TIP (does this tree leak a secret, does the app build, do the
// protocols still have teeth), not about whether an intermediate commit is coherent. What bisect actually
// lands on is a broken build or a failing test, and those are exactly what runs here.
//
// The ledger records which gate each commit passed (`fast` vs `full`), because stamping them alike would put
// the same lie one level down. The pre-push hook requires a stamp for every pushed commit and `full` on the
// tip — so this script complements `ci:local`, it does not replace it.
//
// Usage: pnpm ci:commits [<base>]   (base defaults to the tracked remote's main)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predatesRule, proveInWorktree, ruleSince, verdictFor } from "./fix-proof.mjs";
import { RUN_OUTPUT_EXCLUDE } from "./hooks/gate-decision.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (args, opts = {}) => spawnSync("git", args, { cwd: root, encoding: "utf8", ...opts });

// `--porcelain` compares the worktree to the INDEX as well as the index to HEAD, and in a tree several
// sessions commit into (via temp indexes, so the real one lags) that reports files as modified whose CONTENT
// is exactly HEAD's. Ask the question that is actually being asked — does the checkout differ from HEAD? —
// with `diff HEAD`, plus untracked files, which a stamp would also be attesting over.
// Refresh the index against the worktree first. `ls-files --others` consults the INDEX, so a file the
// ref already has but a stale index does not know about is reported as untracked — which in this tree is
// routine, and made the gate refuse to run on a clean checkout. `--refresh -q` only re-stats; it changes
// no content.
git(["read-tree", "HEAD"]);
git(["update-index", "--refresh", "-q", "--unmerged"]);
// ⚠️ `evals/history.jsonl` is excluded, exactly as `ci-local.mjs` excludes it and for the same reason: it is a
// record a RUN produces, not code a run validates. `ci:local` got the exclusion when the loop was found there —
// append a line, dirty the tree, refuse the stamp, commit the line, move HEAD — and this sibling did not, so
// the loop simply moved one gate over. That is the shape `pnpm guard-siblings` exists for, one layer up.
const dirty = [
  git(["diff", "HEAD", "--name-only", "--", ".", RUN_OUTPUT_EXCLUDE]).stdout.trim(),
  git(["ls-files", "--others", "--exclude-standard", "--", ".", RUN_OUTPUT_EXCLUDE]).stdout.trim(),
]
  .filter(Boolean)
  .join("\n");
if (dirty) {
  console.error("✖ the tree is dirty — a stamp would attest a commit this checkout is not on. Commit first.");
  process.exit(1);
}

// The base: what the remote already has. A commit the remote holds was gated when it was pushed.
const remote = git(["remote"]).stdout.split("\n").filter(Boolean)[0];
const base = process.argv[2] ?? `${remote}/main`;
if (git(["rev-parse", "--verify", "--quiet", base]).status !== 0) {
  console.error(`✖ cannot resolve base '${base}' — pass one explicitly: pnpm ci:commits <base>`);
  process.exit(1);
}

// Oldest first, so a failure names the earliest commit that broke — the one worth fixing.
const commits = git(["rev-list", "--reverse", `${base}..HEAD`])
  .stdout.split("\n")
  .filter(Boolean);
if (commits.length === 0) {
  console.log(`✓ nothing ahead of ${base} — no commit needs a stamp.`);
  process.exit(0);
}

const gitDir = git(["rev-parse", "--absolute-git-dir"]).stdout.trim();
const commonDir = path.resolve(root, git(["rev-parse", "--git-common-dir"]).stdout.trim());
const ledgers = [...new Set([gitDir, commonDir])].map((d) => path.join(d, "everdict-ci-ok"));
const readLedger = () => {
  const file = ledgers.find((f) => existsSync(f));
  if (file === undefined) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (l.includes(" ") ? l : `${l} full`));
};
const stampedAlready = new Set(readLedger().map((l) => l.split(" ")[0]));

// ── …AND A STAMP IS ABOUT A TREE, SO A REWRITE DOES NOT SPEND THE WALK AGAIN ────────────────────────
//
// What this walk proves is lint+typecheck+test on a commit's CONTENT and `pnpm fix-proof` on its DIFF. Both
// are functions of (tree, parent tree), and neither moves when a commit is reworded, reordered or rebased
// onto an identical predecessor — only the sha does. Measured on the session that wrote this: three history
// repairs, each invalidating every stamp, each re-running an hour of the same suites over trees that had
// already passed them.
//
// The equivalence is (tree, parent tree) rather than tree alone because the fix-proof half reverts to the
// PARENT: a commit whose content is unchanged but whose parent moved has a different diff and is not proved.
// `pre-push-gate.mjs` resolves the same equivalence when it reads the ledger, from the same two facts.
const treeKeyOf = (sha) => {
  const tree = git(["rev-parse", `${sha}^{tree}`]).stdout.trim();
  if (tree === "") return undefined;
  return `${tree} ${git(["rev-parse", `${sha}^^{tree}`]).stdout.trim()}`;
};
const provenTrees = new Set();
for (const sha of stampedAlready) {
  const key = treeKeyOf(sha);
  if (key !== undefined) provenTrees.add(key);
}

// A throwaway worktree: the checks run against a checkout of each commit, never by moving this one. The
// script must not disturb the tree the maintainer is working in — that is how a "verification" step becomes
// the thing that loses work.
// OUTSIDE the git directory. Placing it at `<gitDir>/everdict-commit-gate` put a pnpm workspace inside
// `.git/`, where the workspace globs and the store links do not resolve the way they do in a normal
// checkout: every commit came back with TS2742 ("the inferred type cannot be named without a reference
// to …"), which is an install-layout symptom and not a fact about the commit. A gate that reports RED on
// a healthy commit is worse than no gate — it teaches you to disbelieve it.
const wt = path.join(tmpdir(), `everdict-commit-gate-${path.basename(root)}`);
if (existsSync(wt)) git(["worktree", "remove", "--force", wt]);
git(["worktree", "add", "--detach", "--quiet", wt, "HEAD"]);

const fixRuleSince = ruleSince(root);
const FAST = [
  ["pnpm lint", ["lint"]],
  ["pnpm typecheck", ["typecheck"]],
  ["pnpm test", ["test"]],
];

let failed;
// What to re-run in the kept worktree when something breaks — the args, not the label, so the message is a
// command an operator can paste rather than a description of one.
let failedArgs = [];
const stamped = [];
try {
  for (const [i, sha] of commits.entries()) {
    const short = sha.slice(0, 9);
    const subject = git(["log", "-1", "--format=%s", sha]).stdout.trim().slice(0, 68);
    const key = treeKeyOf(sha);
    const byTree = !stampedAlready.has(sha) && key !== undefined && provenTrees.has(key);
    if (stampedAlready.has(sha) || byTree) {
      console.log(
        `· ${short} already stamped${byTree ? " (same tree and parent as a stamped commit)" : ""} — ${subject}`,
      );
      if (byTree) stamped.push(sha); // record the sha too, so the hook need not re-derive it
      continue;
    }
    console.log(`\n▶ [${i + 1}/${commits.length}] ${short} — ${subject}`);
    git(["-C", wt, "checkout", "--detach", "--quiet", sha]);
    // A commit's own lockfile/deps: install once per commit is correct but slow, and this repo's workspace
    // deps are stable across a push. `--offline` keeps it honest (a commit that needs a NEW dependency fails
    // here rather than silently borrowing the tip's node_modules).
    const install = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: wt,
      stdio: "inherit",
    });
    if (install.status !== 0) {
      failed = `${short} — pnpm install`;
      failedArgs = ["install", "--frozen-lockfile", "--prefer-offline"];
      break;
    }
    const broke = FAST.find(([label, args]) => {
      console.log(`  ▶ ${label}`);
      return spawnSync("pnpm", args, { cwd: wt, stdio: "inherit" }).status !== 0;
    });
    if (broke) {
      failed = `${short} — ${broke[0]}`;
      failedArgs = broke[1];
      break;
    }
    // ── a fix's test was red on the pre-fix code, or it proved nothing ──────────────────────────
    //
    // `pnpm fix-proof` reads the rule (a fix carries a test, or says why not); this is the proof, done here
    // because this is the one place the commit is already checked out with its dependencies installed and
    // its siblings built. Source hunks reverted to the parent, the commit's own test files run, RED required,
    // tree restored. Only for a fix that touches both a test and a source file under packages/** or apps/**,
    // so an ordinary push pays nothing for it.
    const proof = verdictFor({
      subject: git(["log", "-1", "--format=%s", sha]).stdout.trim(),
      body: git(["log", "-1", "--format=%b", sha]).stdout,
      files: git(["show", "--name-only", "--format=", sha]).stdout.split("\n").filter(Boolean),
    });
    // Same boundary as `pnpm fix-proof`: a fix older than the rule is outside it, so a fresh checkout walking
    // the whole branch does not prove commits that were never asked to carry a test.
    if (proof.kind === "proof-owed" && !predatesRule(root, sha, fixRuleSince)) {
      console.log("  ▶ fix proof — the commit's tests on its pre-fix source");
      const proved = proveInWorktree({ wt, sha, source: proof.source, tests: proof.tests, log: console.log });
      if (!proved.ok) {
        failed = `${short} — fix proof: ${proved.why}`;
        failedArgs = ["fix-proof"];
        break;
      }
      console.log(`    ✓ red on the pre-fix code: ${proved.ran.join(", ")}`);
    }
    stamped.push(sha);
  }
} finally {
  // ── A RED THAT CANNOT BE DIAGNOSED IS A RED THAT GETS RE-RUN (arch-review 69) ────────────────────
  //
  // This gate went red once with `pnpm test` at the tip and passed on an immediate re-run with no change.
  // Two things made that undiagnosable, and both were here:
  //
  //   the step runs `stdio: "inherit"`, so WHICH test failed scrolled past among thousands of lines
  //   the worktree is destroyed unconditionally, so there was nothing left to look at afterwards
  //
  // A gate whose failures can only be answered by running it again teaches you to run it again — which is
  // precisely how a real red reaches the remote. So a FAILED run keeps its worktree and says where it is;
  // a green one still cleans up, because the cost is only paid when something is already wrong.
  if (failed === undefined) git(["worktree", "remove", "--force", wt]);
}

if (stamped.length > 0) {
  const kept = readLedger().filter((l) => !stamped.includes(l.split(" ")[0]));
  const next = [...kept, ...stamped.map((s) => `${s} fast`)].slice(-200);
  for (const file of ledgers) writeFileSync(file, `${next.join("\n")}\n`);
}

if (failed !== undefined) {
  console.error(
    `\n✖ COMMIT GATE RED at ${failed}.\n  That commit is in the push and would be a hole in the history. Fix it where it is (rebuild the\n  commit rather than appending a repair on top), then re-run.`,
  );
  // Kept ON PURPOSE (see the `finally` above): re-run the failing step here to see what broke, instead of
  // re-running the whole gate and hoping it stays red long enough to read.
  console.error(
    `\n  The worktree is KEPT for diagnosis, checked out at the failing commit:\n    cd ${wt} && pnpm ${failedArgs.join(" ")}\n  It is reused (and reset) by the next run, so there is nothing to clean up by hand.`,
  );
  process.exit(1);
}
console.log(
  `\n✓ COMMIT GATE GREEN — ${commits.length} commit(s) ahead of ${base}, each lint+typecheck+test clean ` +
    `(${stamped.length} newly stamped fast). The TIP still needs \`pnpm ci:local\` for the full gate.`,
);
