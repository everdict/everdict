#!/usr/bin/env node
// watches: nothing — runs a named gate and reads its own header; it declares no vocabulary of its own.
//
// `pnpm triage <gate>` — the judgement step that was being done by hand every time.
//
// Every `scripts/check-*.mjs` in this tree opens with the incident that put it there and the repairs it will
// accept, usually two and explicitly "never a third". The failure output is the summary; the header is the
// reasoning, and reading it was a thing a person did from memory for twenty-three different gates.
//
// ⚠️ IT REPORTS AND NEVER APPLIES. A triager that repairs is the author reviewing itself, and widening an
// allowlist to make a gate green is the one move every allowlist in this tree is written to refuse.
//
// Read-only session, no worktree needed: it reads, it does not run the repository.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = process.argv[2];

const scripts = readdirSync(path.join(root, "scripts")).filter((f) => f.startsWith("check-") && f.endsWith(".mjs"));
const names = scripts.map((f) => f.replace(/^check-|\.mjs$/g, "")).sort();

if (gate === undefined || gate.startsWith("-")) {
  console.error(`✖ triage: name a gate. Known: ${names.join(" ")}`);
  process.exit(1);
}
const scriptFile = path.join(root, "scripts", `check-${gate}.mjs`);
if (!existsSync(scriptFile)) {
  console.error(`✖ triage: no scripts/check-${gate}.mjs. Known: ${names.join(" ")}`);
  process.exit(1);
}

// Run it first. A triage of a gate that is currently GREEN is a question about nothing, and answering it
// anyway is how a tool teaches people that its answers are decorative.
console.log(`▶ triage · ${gate}\n`);
const run = spawnSync("node", [scriptFile], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
if (run.status === 0) {
  console.log(`✓ ${gate} is green — nothing to triage.\n\n${output.slice(0, 600)}`);
  process.exit(0);
}

// The header is the reasoning. Take the leading comment block, which is where every scanner here records the
// incident and the repairs it accepts.
const src = readFileSync(scriptFile, "utf8");
const header = src
  .split("\n")
  .slice(0, 80)
  .filter((l) => l.startsWith("//") || l.startsWith("#!"))
  .join("\n");

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.error(
    `✖ triage: the \`claude\` CLI is not runnable here.\n\nThe gate's own output and header follow; they are what the triage would have read.\n\n${output}\n\n${header}`,
  );
  process.exit(1);
}

const prompt = [
  `The gate \`pnpm ${gate}\` is RED. Two things follow: its output, and the header of the script that produced`,
  "it. That header records the incident the gate exists for and the repairs it will accept.",
  "",
  "Report, in at most fifteen lines:",
  "1. which rung fired, and what it actually read;",
  "2. whether this looks like a real finding or like the gate looking at the wrong corpus — several scanners",
  "   here shipped first drafts that generated false findings, and the header often says so;",
  "3. the repairs the header itself names, quoted, and which one fits this site.",
  "",
  "Do NOT apply anything, and never suggest widening an allowlist to make the gate green: every allowlist here",
  "requires a reason, and an entry whose site stopped needing it fails on its own.",
  "",
  "── gate output ──",
  output.slice(0, 20_000),
  "",
  "── script header ──",
  header,
].join("\n");

const res = spawnSync(
  "claude",
  [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    "sonnet",
    "--disallowedTools",
    "Edit,Write,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch",
    "--allowedTools",
    "Read,Grep,Glob",
  ],
  { cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
);
if (res.status !== 0) {
  console.error(`✖ triage: claude exited ${res.status}. The gate's output is above; triage it by hand.`);
  process.exit(1);
}
try {
  const envelope = JSON.parse(res.stdout);
  console.log(envelope.result);
  console.log(
    `\n· read scripts/check-${gate}.mjs's header · $${(envelope.total_cost_usd ?? 0).toFixed(4)} · reported, not applied`,
  );
} catch {
  console.error("✖ triage: unparseable envelope.");
  process.exit(1);
}
process.exit(1); // the gate is still red, and this process must not read as a pass
