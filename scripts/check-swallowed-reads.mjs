#!/usr/bin/env node
// watches: nothing — it matches a SPELLING, not a symbol; there is no name here that could die.
//
// ── L2 BANS THESE BY NAME, AND NOTHING READ FOR THEM ─────────────────────────────────────────────
//
// `.claude/rules/protocol.md` L2: *"Banned: `.catch(() => [])`, `.catch(() => undefined)`,
// `.catch(() => ({}))` on any read a decision rests on."* Named, in a rule, for months — and
// `grep -l "catch(() =>" scripts/check-*.mjs` returned nothing. This repository had twenty-seven bespoke
// gates and the law with the most case law behind it was enforced by prose.
//
// It came back. `CampaignService.inheritedFindings` shipped
// `await this.deps.store.get(tenant, id).catch(() => undefined)` — the campaign store returns `undefined`
// for a record this workspace does not have and THROWS when the read did not happen, so the line spelled a
// store outage exactly like a deleted ancestor, and the brief handed the delegate an empty inheritance that
// reads as "the earlier walks established nothing". The remedy already existed FORTY LINES ABOVE in the same
// method (`evidenceUnavailable`), by the same author, in the same brief.
//
// ── WHAT IT MATCHES, AND WHY IT IS NARROW ────────────────────────────────────────────────────────
//
// The law's scope is "a read A DECISION RESTS ON", which a scanner cannot see. The whole tree has 331
// occurrences of the spellings, and wiring a gate over all of them is how a check teaches people to skip its
// output. So the proxy is the one structural fact that separates them: THE VALUE GETS A NAME.
//
//     const x = await store.get(…).catch(() => undefined)   ← flagged. Something below decides with `x`.
//     void notify(…).catch(() => undefined)                 ← not. Fire-and-forget is its own hatch in L2,
//                                                             and it needs a different repair (record it).
//     await res.json().catch(() => ({}))                    ← not. Decoding a body that may not be JSON is
//                                                             not a failed READ; the request already
//                                                             succeeded or failed on its own terms.
//
// Erring toward missing one rather than inventing one, deliberately: the 188 unbound occurrences include
// real defects, and they are found by `pnpm scan` and by review, which can read what the value is for.
//
// ⚠️ AND IT READS LOGICAL STATEMENTS, NOT LINES — because its first version did not, and the formatter
// decides where the lines are. A chain long enough to wrap is exactly the shape this is about:
//
//     const members = await controlPlane
//       .listMembers(ctx)
//       .then((r) => membersSchema.parse(r))
//       .catch(() => [])
//
// Twenty-seven statements were invisible that way, in a gate whose own comment claimed to cover "the value
// gets a name". Found by the self-review pass that asks what a REFUSAL wrongly lets through, not by reading
// the regex. The join is deliberately minimal: a line whose first non-space character is `.` or `?.`
// belongs to the line above it. Spanning newlines with `[^;]*?` instead would have been shorter and wrong —
// `apps/web` is written without semicolons, so that pattern runs to the end of the file and matches across
// unrelated statements.
//
// ── A RATCHET, NOT A WALL ────────────────────────────────────────────────────────────────────────
//
// 141 exist today across 73 files — the sum of `scripts/swallowed-reads-baseline.txt`, which is the number a
// reader can check rather than an adjective. Every move is recorded, because a baseline that grows without an
// explanation is indistinguishable from one that was quietly re-based:
//
//     83  → 105   a correction, not a change: the line claimed 83 while the file summed to 105 across 61
//                 files (a running total somebody stopped counting partway down). Nothing was scanned that
//                 had not been scanned before.
//     105 → 132   a WIDENING: the glob gained `.tsx`, which it had never matched, and `apps/web` is almost
//                 entirely `.tsx`. That added 27 occurrences across 17 files — all of them pre-existing and
//                 none of them new debt, but none of them previously visible either. The ratchet had been
//                 reporting PASS over a region it could not read.
//     132 → 131   a debt REPAID: `agent-activation.ts` stopped swallowing a registry read, and the ratchet
//                 refused the change until the baseline said so, which is the arm working.
//     131 → 143   a WIDENING, and the second time this scanner was found blind over a region it reported
//                 PASS on. +21 for the conditional shape described above, −9 for `request.json()` decodes
//                 the exclusion had always meant to cover and could not name. Nothing here is new debt; all
//                 21 predate the change, and one of them — a harness registry read in
//                 `scorecard-service.ts` — is the exact sibling of the defect that prompted the widening.
//     143 → 141   two debts REPAID in the change that revealed them: `verifyManifest`'s harness and dataset
//                 reads now answer `unverifiable` where they used to answer `missing`.
//
// Each is a place the TYPE failed to say it, and L2 says so itself: *"A scanner with an
// allowlist is a design admission, not a solution."* The baseline is that admission, written down and
// counted. What is refused is a NEW one — and a file whose count has DROPPED must update the baseline in the
// same change, because a debt that quietly stops shrinking on paper stops being a debt anybody pays.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(root, "scripts", "swallowed-reads-baseline.txt");
const write = process.argv.includes("--write");

// The empty values L2 names, plus the four spellings of the same collapse it does not enumerate. `0` and `""`
// are here because "we could not find out" becoming a quantity is the same erasure as it becoming a set.
const EMPTY = String.raw`(\[\]|undefined|null|false|true|\(\{\}\)|\{\}|0|""|'')`;
const BOUND = new RegExp(
  String.raw`(?:const|let|var)\s+[\w{}\[\],:\s]+=[^;\n]*?\bawait\s+[^;\n]*?\.catch\(\(\)\s*=>\s*${EMPTY}\)`,
);
// A response body is not a read that failed — the request already reported its own outcome.
// ⚠️ `req`/`request` ARE ON THIS LIST, and were not until the widening above made them reachable. The
// alternation named `res|response|reply|body`, all of them the ANSWER side; an INBOUND body is decoded the
// same way and for the same reason (`const body = (await request.json().catch(() => ({}))) as {…}` in a
// Next.js route handler — a malformed body reads as an absent field, which is what the handler already has
// to handle). The exclusion described one direction of one idiom, and the moment the pattern could see the
// parenthesised form it started refusing two healthy route handlers. A check nobody reads is worse than none.
const DECODE = /\b\w*(?:res|response|reply|body|req|request)\s*\.\s*(?:json|text|arrayBuffer)\s*\(\s*\)\s*\.catch/i;

const files = execFileSync(
  "git",
  [
    "ls-files",
    "packages/*/src/**/*.ts",
    "apps/*/src/**/*.ts",
    "packages/*/src/*.ts",
    "apps/*/src/*.ts",
    // ⚠️ `.tsx` WAS MISSING, AND apps/web IS ALMOST ENTIRELY `.tsx`. The ratchet reported PASS over a region
    // it never read — the empty-corpus failure one directory in, where the corpus is not empty but a whole
    // file extension is absent from it. Found by `pnpm review`, which counted what the glob could not see.
    "packages/*/src/**/*.tsx",
    "apps/*/src/**/*.tsx",
    "packages/*/src/*.tsx",
    "apps/*/src/*.tsx",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\n")
  .filter((f) => f !== "" && !/\.test\.|\.spec\./.test(f));

// An empty corpus reads exactly like coverage, and the failure is silent for as long as nobody asks.
if (files.length === 0) {
  console.error("✖ swallowed-reads: no source files matched. Refusing to report over an empty corpus.");
  process.exit(1);
}

// A continuation line is part of the statement above it. Two shapes qualify and no others:
//
//   `.foo(…)` / `?.foo(…)`   a wrapped member-access chain (the original rule)
//   `? a` / `: b`            a wrapped CONDITIONAL — the arm of a ternary the formatter broke across lines
//
// ⚠️ THE SECOND ONE WAS MISSING, AND SO WAS THE HALF OF THE PATTERN THAT DEPENDS ON IT. `pnpm scan` found two
// L2 violations in `apps/api/src/composition/sandbox.ts` — a harness registry read whose failure was spent as
// "not registered" — and this check reported that file clean throughout, twice over:
//
//     const spec = harnesses
//       ? await harnesses.get(tenant, ref.id, ref.version ?? "latest").catch(() => undefined)
//       : undefined;
//
// Neither continuation line starts with a `.`, so the statement never joined; and even joined, the pattern
// demanded `= await` ADJACENT, which a conditional never is. Both halves are the same mistake in different
// clothes — reading the shape somebody happened to write rather than the shape the law describes. The law
// says the value gets a name and a decision rests on it, and `const x = cond ? await … : undefined` is that
// sentence exactly. So `await` may now sit anywhere on the right-hand side, still bounded by the statement
// (`[^;\n]`), and a ternary arm joins like a chain does.
//
// This is the SECOND time this scanner has been found blind over a region it reported PASS on, after the
// missing `.tsx` glob below. Both were found by something else looking — a review, then a scan — which is
// the argument for keeping both running rather than for trusting either.
const CONTINUATION = /^\s*(?:\??\.|\?\s|:\s)/;
function logicalLines(src) {
  const out = [];
  for (const line of src.split("\n")) {
    if (CONTINUATION.test(line) && out.length > 0) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line);
  }
  return out;
}

const found = new Map();
for (const file of files) {
  let src;
  try {
    src = readFileSync(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  let n = 0;
  for (const line of logicalLines(src)) {
    if (DECODE.test(line)) continue;
    if (BOUND.test(line)) n++;
  }
  if (n > 0) found.set(file, n);
}

const render = () =>
  `${[...found.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([f, n]) => `${n}\t${f}`)
    .join("\n")}\n`;

if (write) {
  writeFileSync(BASELINE, render());
  console.log(
    `· wrote ${path.relative(root, BASELINE)}: ${found.size} file(s), ${[...found.values()].reduce((a, b) => a + b, 0)} occurrence(s).`,
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`✖ swallowed-reads: ${path.relative(root, BASELINE)} is missing. Regenerate it with --write.`);
  process.exit(1);
}
const baseline = new Map(
  readFileSync(BASELINE, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [n, f] = l.split("\t");
      return [f, Number(n)];
    }),
);
if (baseline.size === 0) {
  console.error(
    "✖ swallowed-reads: the baseline is empty, so every file would pass for the same uninformative reason.",
  );
  process.exit(1);
}

const violations = [];
for (const [file, n] of found) {
  const was = baseline.get(file) ?? 0;
  if (n > was)
    violations.push(
      `${file}: ${n} swallowed read(s), baseline ${was}. A read that failed is not an empty value — return the third case (\`ReadResult\`, or a \`…Unavailable\` reason the consumer renders) and make the caller name it. See .claude/rules/protocol.md L2.`,
    );
}
for (const [file, was] of baseline) {
  const n = found.get(file) ?? 0;
  if (n < was)
    violations.push(
      `${file}: ${n} swallowed read(s), baseline ${was} — the debt shrank and the baseline did not. Run \`pnpm swallowed-reads --write\` in the SAME change; a baseline that outlives what it recorded reads as permission.`,
    );
}

if (violations.length > 0) {
  console.error(`\n✖ swallowed-reads: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
const total = [...found.values()].reduce((a, b) => a + b, 0);
console.log(
  `PASS swallowed reads: ${files.length} files, ${total} baselined occurrence(s) in ${found.size} file(s) — no new one, none silently repaid.`,
);
