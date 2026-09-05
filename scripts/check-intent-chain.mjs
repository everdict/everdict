#!/usr/bin/env node
// Intent-chain guard — the Plan/Build handoff, enforced instead of stated (`intent/README.md`).
//
// A plan written after the diff is not a plan, it is a description that agrees with itself, and nothing in a
// repository can tell the two apart by reading them: both are markdown that matches the code. The only
// witness is the COMMIT ORDER, so this check asks git the three questions the prose version can only request:
//
//   1. every change directory carries an `intent.md` in the shape `intent/TEMPLATE.md` declares;
//   2. a `plan.md` CITES the commit that introduced its intent (`From: intent.md @ <sha>`), and that commit
//      is an ancestor of the plan's own — a plan cannot precede the request it answers;
//   3. `Status: shipped` names the commit that landed it, and that commit is STRICTLY later than the plan.
//
// Rule 2 is the load-bearing one. This repository's commit messages have always been intent-shaped, but they
// are written after the work; the audit that produced this directory found zero pre-implementation artifacts
// against 2,710 commits in 90 days. Recording the intent afterwards would reproduce exactly that, one
// directory further in, and would pass any check that only reads the files.
//
// A SHALLOW checkout cannot answer any of it. That is not a pass — the check refuses to run rather than
// report green over questions it never asked (ci.yml gives the core job `fetch-depth: 0` for this reason).
//
// Reads SOURCE + git history only (no build, no deps), prints every violation, exits 1.
// watches: nothing — reads intent artifacts and the commit graph.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = path.join(root, "intent");
const rel = (p) => path.relative(root, p);

const violations = [];
const notes = [];
const fail = (message) => violations.push(message);

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const gitOut = (...args) => git(...args).stdout.trim();
const gitOk = (...args) => git(...args).status === 0;

// ── preconditions ────────────────────────────────────────────────────────────────────────────────
if (!existsSync(home)) {
  console.error("✖ intent-chain: intent/ is missing. The Plan stage has no home — see intent/README.md.");
  process.exit(1);
}
if (gitOut("rev-parse", "--is-shallow-repository") === "true") {
  console.error(
    "✖ intent-chain: shallow checkout — the ordering rules cannot be asked, and an unasked question is not a pass.\n  Fetch full history (`git fetch --unshallow`, or `fetch-depth: 0` in the workflow) and re-run.",
  );
  process.exit(1);
}
for (const required of ["README.md", "TEMPLATE.md", "PLAN-TEMPLATE.md"]) {
  if (!existsSync(path.join(home, required)))
    fail(`intent/${required} is missing — the shape it defines is what this check enforces.`);
}

// ── the shapes ───────────────────────────────────────────────────────────────────────────────────
const INTENT_SECTIONS = ["Problem", "Proposed outcome", "Affected users and systems", "Constraints", "Open questions"];
const PLAN_SECTIONS = ["Files that change", "Order of work", "Risks", "Proof"];
const STATUSES = ["draft", "accepted", "rejected", "shipped"];
const DIR_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

/** The commit that INTRODUCED a tracked path, or undefined when the path is not committed yet. */
const introducedBy = (file) => {
  const log = gitOut("log", "--diff-filter=A", "--format=%H", "--", rel(file));
  if (!log) return undefined;
  const lines = log.split("\n").filter(Boolean);
  return lines[lines.length - 1]; // git logs newest-first; the oldest add is the introduction
};
const resolves = (sha) => gitOk("cat-file", "-e", `${sha}^{commit}`);
const isAncestor = (a, b) => gitOk("merge-base", "--is-ancestor", a, b);
const short = (sha) => sha.slice(0, 8);

const headingsOf = (body) =>
  body
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());

// ── walk the change directories ──────────────────────────────────────────────────────────────────
const changes = readdirSync(home)
  .filter((name) => statSync(path.join(home, name)).isDirectory())
  .sort();

for (const name of changes) {
  const dir = path.join(home, name);
  const label = `intent/${name}`;
  if (!DIR_NAME.test(name)) fail(`${label}: directory name must be <YYYY-MM-DD>-<slug> (lowercase, hyphens).`);

  const intentFile = path.join(dir, "intent.md");
  if (!existsSync(intentFile)) {
    fail(`${label}: no intent.md. A change directory without the request it came from records nothing.`);
    continue;
  }
  const intent = readFileSync(intentFile, "utf8");

  if (!/^Author:\s*\S/m.test(intent)) fail(`${label}/intent.md: no \`Author:\` line — the record has no originator.`);
  const status = /^Author:.*?Status:\s*([a-z]+)/ms.exec(intent)?.[1] ?? /^Status:\s*([a-z]+)/m.exec(intent)?.[1];
  if (!status || !STATUSES.includes(status)) {
    fail(`${label}/intent.md: \`Status:\` must be one of ${STATUSES.join(" | ")} (found ${status ?? "nothing"}).`);
  }
  // The accept/reject decision IS the Plan-stage gate, and half of it left nothing behind: a rejected idea in
  // the tree with no reason is the same as a deleted one, except it also looks like a decision.
  if (status === "rejected" && !/^Rejected:\s*\S/m.test(intent)) {
    fail(
      `${label}/intent.md: \`Status: rejected\` with no \`Rejected: <why>\` line. A turned-down idea is a record only if it says what turned it down.`,
    );
  }

  const intentHeadings = headingsOf(intent);
  for (const section of INTENT_SECTIONS) {
    if (!intentHeadings.includes(section))
      fail(`${label}/intent.md: missing section "## ${section}" (intent/TEMPLATE.md).`);
  }

  // Reported, never failed. Not every change needs a design pass, and a gate that insists otherwise gets
  // routed around — but an accepted intent nobody has designed against is invisible without this line, which
  // is how this repository reached ten change directories and zero specs.
  if (status === "accepted" && !existsSync(path.join(dir, "spec.md"))) {
    notes.push(`${label}: accepted, and no spec.md. \`pnpm design --next\` takes the oldest of these.`);
  }

  const intentSha = introducedBy(intentFile);
  if (!intentSha) {
    notes.push(
      `${label}: intent.md is not committed yet — its ordering rules are deferred to the commit that adds it.`,
    );
  }

  // ── spec.md: the same ordering law as plan.md ──────────────────────────────────────────────────
  //
  // Added because the design pass that WRITES these specs was reviewed by one, and it pointed out that
  // `spec.md` had no ordering rule at all — so a spec could be back-dated exactly the way a plan could before
  // this check existed. Descent from the intent only: this change is the counterexample to spec-before-plan
  // (the design pass necessarily came after its own plan), and a rule with a permanent exception is worse than
  // a narrower rule that holds.
  const specFile = path.join(dir, "spec.md");
  if (existsSync(specFile)) {
    const spec = readFileSync(specFile, "utf8");
    const citedSpec = /^From:\s*intent\.md\s*@\s*([0-9a-f]{7,40})\s*$/m.exec(spec)?.[1];
    if (!citedSpec) {
      fail(
        `${label}/spec.md: no \`From: intent.md @ <sha>\` line. A spec that does not name its request cannot be checked against it.`,
      );
    } else if (!resolves(citedSpec)) {
      fail(`${label}/spec.md: \`From:\` names ${citedSpec}, which is not a commit in this history.`);
    } else if (intentSha && gitOut("rev-parse", citedSpec) !== intentSha) {
      fail(
        `${label}/spec.md: \`From:\` names ${short(citedSpec)}, but intent.md was introduced by ${short(intentSha)}.`,
      );
    }
    // The policy version the spec was written under. Without it a spec that predates a rule change cannot be
    // told from one that followed it, and a plan gets written against constraints that have since moved.
    const policy = /^Policies:\s*([0-9a-f]{7,40})\s*$/m.exec(spec)?.[1];
    if (!policy) {
      fail(`${label}/spec.md: no \`Policies: <sha>\` line naming the \`.claude/\` tree it was written under.`);
    } else if (!gitOk("cat-file", "-e", policy)) {
      fail(`${label}/spec.md: \`Policies:\` names ${short(policy)}, which is not an object in this history.`);
    }

    // "Areas of concern" is the point of the design pass — the spec prompt says an empty one is suspicious —
    // and nothing read it, so a plan could be written against a spec whose concerns were all open. That is the
    // exact sequence the article puts a gate in front of: the owner resolves each one with its policy owner
    // BEFORE engineering sees the spec.
    //
    // A status line rather than parsed prose, deliberately: the section's shape is whatever the design pass
    // produced, and a check that guesses at bullets refuses specs for the wrong reason. `carried` is a legal
    // answer — the article carries open questions forward into the plan.
    const concerns = /^Concerns:\s*(open|resolved|carried)\b/m.exec(spec)?.[1];
    if (!concerns) {
      fail(
        `${label}/spec.md: no \`Concerns: open|resolved|carried\` line. The design pass flags concerns so a person settles them; a spec that does not say whether they were settled cannot be planned against.`,
      );
    } else if (concerns === "open" && existsSync(path.join(dir, "plan.md"))) {
      fail(
        `${label}: plan.md exists while spec.md still says \`Concerns: open\`. Settle them (\`resolved\`) or carry them forward with a reason (\`carried\`) — planning against open concerns is the sequence the design pass exists to prevent.`,
      );
    }

    const specSha = introducedBy(specFile);
    if (specSha && intentSha && !isAncestor(intentSha, specSha)) {
      fail(
        `${label}: spec.md (${short(specSha)}) does not descend from intent.md (${short(intentSha)}). A spec committed before or beside its intent was written to fit work already done.`,
      );
    }
    if (!specSha) notes.push(`${label}: spec.md is not committed yet — its ordering rules are deferred.`);
  }

  // ── plan.md: rule 2 ────────────────────────────────────────────────────────────────────────────
  const planFile = path.join(dir, "plan.md");
  let planSha;
  if (existsSync(planFile)) {
    const plan = readFileSync(planFile, "utf8");
    const planHeadings = headingsOf(plan);
    for (const section of PLAN_SECTIONS) {
      if (!planHeadings.includes(section))
        fail(`${label}/plan.md: missing section "## ${section}" (intent/PLAN-TEMPLATE.md).`);
    }
    const cited = /^From:\s*intent\.md\s*@\s*([0-9a-f]{7,40})\s*$/m.exec(plan)?.[1];
    if (!cited) {
      fail(
        `${label}/plan.md: no \`From: intent.md @ <sha>\` line. A plan that does not name its request cannot be checked against it.`,
      );
    } else if (!resolves(cited)) {
      fail(`${label}/plan.md: \`From:\` names ${cited}, which is not a commit in this history.`);
    } else if (intentSha && gitOut("rev-parse", cited) !== intentSha) {
      fail(
        `${label}/plan.md: \`From:\` names ${short(cited)}, but intent.md was introduced by ${short(intentSha)}. Cite the commit that actually carries the request.`,
      );
    }
    planSha = introducedBy(planFile);
    if (planSha && intentSha && !isAncestor(intentSha, planSha)) {
      fail(
        `${label}: plan.md (${short(planSha)}) does not descend from intent.md (${short(intentSha)}). A plan committed before or beside its intent was written to fit work already done.`,
      );
    }
    if (!planSha) notes.push(`${label}: plan.md is not committed yet — its ordering rules are deferred.`);
  }

  // ── shipped: rule 3 ────────────────────────────────────────────────────────────────────────────
  if (status === "shipped") {
    const shipped = /^Shipped:\s*([0-9a-f]{7,40})\s*$/m.exec(intent)?.[1];
    if (!shipped) {
      fail(
        `${label}/intent.md: \`Status: shipped\` with no \`Shipped: <sha>\` — a settlement that names nothing settles nothing.`,
      );
    } else if (!resolves(shipped)) {
      fail(`${label}/intent.md: \`Shipped:\` names ${shipped}, which is not a commit in this history.`);
    } else if (planSha) {
      const shippedSha = gitOut("rev-parse", shipped);
      if (shippedSha === planSha || !isAncestor(planSha, shippedSha)) {
        fail(
          `${label}/intent.md: \`Shipped:\` (${short(shippedSha)}) is not strictly later than plan.md (${short(planSha)}). The implementation cannot land in or before the commit that planned it.`,
        );
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
for (const note of notes) console.log(`· ${note}`);
if (violations.length > 0) {
  console.error(`\n✖ intent-chain: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\n  intent/README.md states the chain; this check is the part of it git can refuse.");
  process.exit(1);
}
console.log(
  `✓ intent-chain: ${changes.length} change director${changes.length === 1 ? "y" : "ies"} — the chain holds.`,
);
