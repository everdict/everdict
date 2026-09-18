#!/usr/bin/env node
// A PLUGIN CHANGE THAT DOES NOT MOVE THE VERSION NEVER REACHES A SESSION.
//
// `claude plugin update` is version-gated: it compares `plugin/.claude-plugin/plugin.json`'s `version`
// against the installed copy's, answers "already at the latest version" when they match, and copies nothing.
// The installed plugin is a SNAPSHOT under ~/.claude/plugins/cache, so a hook edited in this tree keeps
// running its old bytes until that string moves.
//
// Measured on 2026-09-18: the version had been `0.1.0` since the plugin was created, and SEVENTEEN commits
// had touched `plugin/` since — including one that changed what the Stop guard demands and one that removed
// a false sentence from the text every session is opened with. All seventeen were inert in every installed
// copy, and the CLI reported ✔ each time somebody tried to update.
//
// So the obligation is mechanised rather than remembered. The invariant is a fact git can refuse:
//
//     no commit that touches `plugin/` may be NEWER than the commit that last changed the version
//
// watches: nothing — it reads git history and one manifest, not a source symbol vocabulary. The thing that
// would make it dead is `plugin/` moving or the manifest losing its `version`, and both are refusals below.
// Run: node scripts/check-plugin-version.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MANIFEST = "plugin/.claude-plugin/plugin.json";

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
const fail = (...lines) => {
  console.error("plugin version check FAILED —");
  for (const line of lines) console.error(`  ${line}`);
  console.error("\nSee docs/architecture/change-campaign-spec.md and DEFAUL-51 for what this gate is protecting.");
  process.exit(1);
};

// ── THE CORPUS IS PROVEN BEFORE ANYTHING IS REPORTED ──────────────────────────────────────────────────
// A scanner with nothing to look at reads exactly like coverage. Each of these is an ERROR naming what it
// could not find, never a pass.
if (!existsSync(resolve(ROOT, MANIFEST))) fail(`${MANIFEST} does not exist — there is no version to gate`);

const tracked = git("ls-files", "--", "plugin").split("\n").filter(Boolean);
if (tracked.length === 0) fail("no tracked files under plugin/ — the extraction is broken, not the plugin");

const versionAt = (ref) => {
  try {
    // stderr is dropped HERE and nowhere else: "the manifest did not exist at that ref" is the expected
    // answer at the plugin's first commit, and a gate that prints `fatal:` on its happy path teaches its
    // reader to skim past fatals.
    const out = execFileSync("git", ["-C", ROOT, "show", `${ref}:${MANIFEST}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out).version;
  } catch {
    return undefined;
  }
};

// The newest commit where the version differs from its first parent's. Walking the manifest's own history is
// enough: a version can only change in a commit that touched the file.
const touchedManifest = git("log", "--format=%H", "--", MANIFEST).split("\n").filter(Boolean);
if (touchedManifest.length === 0) fail(`no commit has ever touched ${MANIFEST} — nothing to compare against`);

let versionCommit;
for (const sha of touchedManifest) {
  const parents = git("rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
  const before = parents.length === 0 ? undefined : versionAt(parents[0]);
  if (versionAt(sha) !== before) {
    versionCommit = sha;
    break;
  }
}
if (versionCommit === undefined)
  fail(`no commit in history ever CHANGED the \`version\` in ${MANIFEST} — the gate cannot say what is current`);

// ── THE INVARIANT ─────────────────────────────────────────────────────────────────────────────────────
const stale = git("log", "--format=%h %s", `${versionCommit}..HEAD`, "--", "plugin").split("\n").filter(Boolean);

// The working tree counts too: an uncommitted hook edit is the case a history-only check would miss, and it
// is the commonest one — it is what the author is looking at right now.
const dirty = git("diff", "HEAD", "--name-only", "--", "plugin").split("\n").filter(Boolean);
const dirtyWithoutBump = dirty.length > 0 && !dirty.includes(MANIFEST);

// A bump the author has made and not yet committed COVERS the commits behind it — that is what committing it
// will mean. Without this the check can only ever be run green after the fact, and a gate an author cannot
// run before committing is a gate they find out about from someone else.
const workingVersion = JSON.parse(readFileSync(resolve(ROOT, MANIFEST), "utf8")).version;
const pendingBump = workingVersion !== versionAt("HEAD");

if ((stale.length > 0 && !pendingBump) || dirtyWithoutBump) {
  const version = JSON.parse(readFileSync(resolve(ROOT, MANIFEST), "utf8")).version;
  fail(
    `\`version\` is ${version}, last changed in ${git("log", "--format=%h %s", "-1", versionCommit)}`,
    ...(stale.length > 0
      ? [
          `${stale.length} commit(s) have touched plugin/ SINCE, and none of them reaches an installed session:`,
          ...stale.slice(0, 10).map((l) => `  ${l}`),
          ...(stale.length > 10 ? [`  … and ${stale.length - 10} more`] : []),
        ]
      : []),
    ...(dirtyWithoutBump
      ? [`the working tree changes ${dirty.length} file(s) under plugin/ and does not touch ${MANIFEST}`]
      : []),
    "",
    "Bump the version. `claude plugin update` compares that string and copies nothing when it has not moved,",
    "so a plugin change that skips it is a change nobody will ever run.",
  );
}

const covering = pendingBump
  ? `the bump is UNCOMMITTED and covers the ${stale.length} commit(s) behind it once it lands.`
  : "an installed copy reporting this version is running these bytes.";
console.log(`PASS plugin version: ${workingVersion} covers all ${tracked.length} tracked plugin file(s) — ${covering}`);
