#!/usr/bin/env node
// ── A DISPATCH OPTION THAT NO FORWARDER COPIES (arch-review 69) ─────────────────────────────────────
//
// `DispatchOptions` travels from a use-case, through several decorating dispatchers and the Scheduler, to a
// managed backend. Most links pass the object along whole. The Scheduler cannot: an entry waits in a queue,
// so its options are taken apart into `QueueEntry` fields and REBUILT at `runOne`. That rebuild is an
// allowlist, and a field nobody adds to it is dropped in silence — the producer sets it, the consumer reads
// `options?.x` and finds nothing, and every type checks.
//
// It has now happened twice:
//
//     onActivate          arch-review 58 W2   the authority's activation never reached the birth
//     acknowledgeResult   arch-review 69      the durable handover never reached either managed lane, so
//                                             the crash window the whole of arch-review 67 P0 was about
//                                             stayed open in production
//
// The second one is the reason this file exists rather than another sentence. The rebuild block carries TWO
// comments warning about the first — "this whitelist is the ONE place a hook can silently die" and "it is one
// field on purpose: `onActivate` died here as a second one" — and the third field was dropped three lines
// below them. A law is applied at the moment of writing a call site, not at the moment of reading a rule
// (rule `protocol`), so the part that binds has to be mechanical.
//
// What this checks: every field of `DispatchOptions` reaches every forwarder. A forwarder that passes the
// whole options object through is safe BY CONSTRUCTION and is not asked to name anything; one that rebuilds
// the object must mention each field, or say in `TERMINATES_HERE` why the field stops there.
// watches: nothing — derives the field names from the interface itself, so it cannot go stale.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = "packages/application-control/src/ports/dispatcher.ts";

// A field that deliberately stops at a forwarder. The entry states WHY, in the same shape `guarded-doubles`
// and `unwired-capabilities` use: either this is the seam's PREMISE (fine) or an `OPEN` defect with an owner
// (not fine, and removed by that owner's change). An entry whose file no longer forwards anything FAILS —
// a reason that outlived its subject reads as permission.
const TERMINATES_HERE = [
  // (file, field, why)
];

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

// The field names, read off the interface rather than listed here — a list would be the third copy of the
// thing this check exists to keep singular.
function optionFields() {
  const src = readFileSync(path.join(root, CONTRACT), "utf8");
  const start = src.indexOf("export interface DispatchOptions {");
  if (start === -1) {
    console.error(`✖ option forwarding: DispatchOptions is gone from ${CONTRACT}.`);
    console.error("  This check reads the contract instead of holding its own copy — re-point it.");
    process.exit(2);
  }
  const body = src.slice(start, src.indexOf("\n}", start));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

const FIELDS = optionFields();
if (FIELDS.length === 0) {
  console.error("✖ option forwarding: parsed zero fields off DispatchOptions — the check would pass vacuously.");
  process.exit(2);
}

const roots = ["packages", "apps"].map((d) => path.join(root, d)).filter((d) => statSync(d, { throwIfNoEntry: false }));
const failures = [];
const forwarders = [];

for (const file of roots.flatMap((d) => sourceFiles(d))) {
  const src = readFileSync(file, "utf8");
  const rel = path.relative(root, file);
  if (rel === CONTRACT) continue;
  // A forwarder RECEIVES our options as a parameter and passes work on. Two things this must not confuse:
  //
  //   `Dispatcher.DispatchOptions`   undici's type, in the three HTTP proxy dispatchers. A name collision,
  //                                  and the first draft of this check reported all six fields against each
  //                                  of them — eighteen healthy lines, which is how a scanner teaches people
  //                                  to skip its output (rule `protocol`: an allowlist is a design admission).
  //   `dispatch: (job, o?: X) => …`  a DEPENDENCY's declared signature, not a parameter this file receives.
  //                                  `verifier-pass.ts` declares one and is a PRODUCER of options, not a
  //                                  forwarder of them.
  //
  // So: an unqualified parameter annotation inside a real signature (`name(… o?: DispatchOptions …)`), which
  // the `\w+\s*\(` prefix requires and an interface field's `name: (…)` cannot satisfy.
  const receivesOptions = /\b(?:async\s+)?(?:function\s+)?\w+\s*\([^)]*\b\w+\??:\s*DispatchOptions\b/.test(src);
  if (!receivesOptions || !/\.dispatch(Verifier)?\(/.test(src)) continue;
  // Whole-object forwarding is safe by construction: the field cannot be dropped because it is never
  // enumerated. `f(job, options)` and a spread of the same identifier both qualify.
  const wholesale =
    /\.dispatch(Verifier)?\(\s*[^,()]+,\s*(options|opts|dispatchOptions|o)\s*[),]/.test(src) ||
    /\.\.\.\s*(options|opts|dispatchOptions)\b/.test(src);
  forwarders.push({ rel, wholesale });
  if (wholesale) continue;
  for (const field of FIELDS) {
    if (src.includes(field)) continue;
    const excused = TERMINATES_HERE.find((e) => e.file === rel && e.field === field);
    if (excused) continue;
    failures.push({ rel, field });
  }
}

// An allowlist entry whose subject is gone is permission nobody granted — the same rule the other scanners
// hold, because a stale reason is read as a decision somebody made.
for (const entry of TERMINATES_HERE) {
  if (!forwarders.some((f) => f.rel === entry.file))
    failures.push({ rel: entry.file, field: entry.field, stale: true });
}

if (failures.length > 0) {
  console.error("✖ option forwarding — a DispatchOptions field does not survive a forwarder that rebuilds it:\n");
  for (const f of failures)
    console.error(
      f.stale
        ? `  ${f.rel} — allowlisted for '${f.field}', but this file no longer forwards dispatch options. Remove the entry.`
        : `  ${f.rel} — never mentions '${f.field}'. The producer sets it, the consumer reads undefined, and nothing fails to compile.`,
    );
  console.error(
    "\n  Forward it, or add a TERMINATES_HERE entry saying why the field stops there.\n" +
      "  This seam has silently eaten two fields (onActivate, arch-review 58 W2; acknowledgeResult, 69).",
  );
  process.exit(1);
}

const rebuilders = forwarders.filter((f) => !f.wholesale).length;
console.log(
  `✓ option forwarding — ${FIELDS.length} DispatchOptions fields survive ${forwarders.length} forwarder(s); ` +
    `${rebuilders} rebuild the object and name every field`,
);
