import { describe, expect, it } from "vitest";
import {
  ENVELOPE_REFUSAL_PREFIX,
  PERMISSION_DENIED_PREFIX,
  SHADOW_CAPTURE_PREFIX,
  isKernelRefusal,
} from "./execution-mode.js";

// ── A WITHHELD CALL IS NOT A FAILED ONE, AND NEITHER IS A SUCCESSFUL ONE ─────────────────────────────
//
// `isKernelRefusal` is what the evaluation projectors in apps/agent use to decide a tool call's `ok`, and the
// file's own comment names the stake: "a refusal scored as a successful tool call is the one number the
// evaluation exists to produce". It had no test.
//
// What it owns is exactly this: the three prefixes the kernel itself writes, matched at the START of the
// content. It is deliberately ANCHORED — a tool that reports someone else's permission problem inside its
// output is reporting, not being refused, and scoring that as a kernel refusal would invent a refusal the
// envelope never made.
describe("isKernelRefusal recognises the kernel's own refusals and nothing else", () => {
  it("recognises each prefix the kernel writes", () => {
    for (const prefix of [SHADOW_CAPTURE_PREFIX, PERMISSION_DENIED_PREFIX, ENVELOPE_REFUSAL_PREFIX]) {
      expect(isKernelRefusal(prefix)).toBe(true);
    }
  });

  // The shapes the loop actually renders, not the bare constants: `loop.ts` interpolates a reason and a
  // sentence after each prefix, and a reader that only matched the constant exactly would classify none of
  // the real messages.
  it("recognises the rendered messages, not just the bare prefixes", () => {
    expect(isKernelRefusal(`${ENVELOPE_REFUSAL_PREFIX}out_of_scope): this task is scoped to specific objects.`)).toBe(
      true,
    );
    expect(isKernelRefusal(`${PERMISSION_DENIED_PREFIX} the tool "write_file" was not approved by the user.`)).toBe(
      true,
    );
    expect(isKernelRefusal(`${SHADOW_CAPTURE_PREFIX} The arguments were recorded.`)).toBe(true);
  });

  it("leaves an ordinary tool result alone", () => {
    for (const ordinary of ["", "3 files matched.", "OK", '{"result": true}']) {
      expect(isKernelRefusal(ordinary)).toBe(false);
    }
  });

  // The anchoring, stated as a property rather than as an accident of `startsWith`. A tool whose OUTPUT
  // quotes a permission problem — a shell command's stderr, a file listing, a log excerpt — produced that
  // text by running successfully, and the envelope refused nothing.
  it("does not read a refusal quoted inside a tool's own output as one of ours", () => {
    expect(isKernelRefusal(`the command wrote: ${PERMISSION_DENIED_PREFIX} /etc/shadow`)).toBe(false);
    expect(isKernelRefusal(`log line 4: ${ENVELOPE_REFUSAL_PREFIX}out_of_scope)`)).toBe(false);
  });
});
