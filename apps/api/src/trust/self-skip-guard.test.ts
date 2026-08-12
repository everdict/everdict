import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ── A PRINTED "SKIPPED" IS NOT A SKIP ────────────────────────────────────────────────────────────────
//
// The trust suite's strongest rule is that a scenario which certified nothing is a FAILED certification, and
// the runner enforces it by refusing to certify when vitest reports any test as skipped. That leaves one door
// the rule cannot watch: a test that decides for itself that its infrastructure is missing, prints a warning,
// and RETURNS. Vitest reports that as passed. The runner counts it. `skipped: 0` holds. The certification
// prints PASS over a claim nothing exercised — which is exactly the false green the rule exists to stop,
// reached through the reporter's status field instead of through the test list.
//
// It happened once, to the durability scenario, and it survived review until someone read the nightly
// workflow and noticed the service it needed was never started. So the pattern is banned in code, where it
// can be seen: a trust scenario whose precondition is missing THROWS (the whole file is already skipped by
// its `describe.skipIf` when the suite is not enabled at all, which is the honest way to be quiet).
//
// The scan is deliberately narrow — an early `return` in a helper is ordinary control flow. What it looks for
// is the shape that lies: a bare `return` in an `it` body guarded by a missing-infrastructure check, or a
// console line announcing a skip that the framework will never see.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SELF_SKIP = [
  // "…SKIP…" printed from inside a scenario: whatever it says, the reporter will say `passed`.
  /console\.(warn|log|info)\([^)]*SKIP/i,
  // `it.skip(` / `it.todo(` inside a trust file: the runner counts these as skipped and refuses to certify,
  // which is the correct outcome — but they are usually written believing the opposite, so they are named
  // here to make the intent explicit rather than discovered at 3am in a nightly.
  /\bit\.(skip|todo)\(/,
];

function trustFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return trustFilesUnder(full);
    return name.endsWith(".trust.test.ts") ? [full] : [];
  });
}

describe("trust-suite integrity — a scenario cannot skip itself into a pass", () => {
  const root = path.resolve(HERE, "../../../..");
  const files = [...trustFilesUnder(path.join(root, "apps")), ...trustFilesUnder(path.join(root, "packages"))];

  it("no trust scenario announces its own skip", () => {
    const offenders = files
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return SELF_SKIP.some((pattern) => pattern.test(text));
      })
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("the scanner is looking at the actual suite", () => {
    // A guard whose glob stops matching reports green forever. If the trust files move, this fails and
    // someone points it at the new home rather than deleting it.
    expect(files.length).toBeGreaterThan(20);
  });
});
