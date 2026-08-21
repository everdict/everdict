import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  INLINE_EXPORT_PAYLOAD_CAP_BYTES,
  INLINE_EXPORT_PAYLOAD_MAX_OUTPUT_BYTES,
  inlineExportPayload,
  readExportPayload,
} from "./publication-operation.js";

// ── A COMPRESSED BOUND IS NOT A BOUND (arch-review 59 P1-hardening) ──────────────────────────────────
//
// The inline payload exists so a deployment with no object store can still own its settlement's bytes, and
// it is capped — at 512 KiB of GZIP+BASE64, the size of the row. Nothing bounded what those bytes become.
//
// `readExportPayload` is `gunzipSync` followed by `JSON.parse`, both synchronous, in the publication
// reconciler's own process. Highly repetitive JSON compresses by orders of magnitude, so a row that passed
// the cap can decompress to hundreds of megabytes: one settlement then holds the event loop through a large
// allocation and a large parse, in the loop that every other owed publication is waiting in. This is the
// path a self-hosted install without MinIO takes on EVERY export, so it is not an exotic input.
//
// The repair is the pair the compressed cap was standing in for: a bound on the OUTPUT, applied where the
// bytes are produced (so an oversized settlement is refused at plan time, where an operator can act) and
// again where they are read (so a row written by an older or hostile writer cannot spend the memory anyway).
//
// Seen RED before the output bound existed, observed:
//   Cannot find module — INLINE_EXPORT_PAYLOAD_MAX_OUTPUT_BYTES did not exist
// …and with the bound present but unchecked at read:
//   a row whose bytes decompress past the bound was expanded anyway: expected [Function] to throw

// ~32 MiB of one repeated value, which gzips to tens of kilobytes: it clears the ROW cap by three orders of
// magnitude and is well past what the row may expand to. That gap is the defect, stated as a fixture.
const HUGE = { blob: "a".repeat(32 * 1024 * 1024) };

describe("[R59 COUNTEREXAMPLE] an inline payload is bounded by what it becomes, not only by what it weighs", () => {
  it("REFUSES to write a settlement whose bytes expand past the output bound", () => {
    expect(
      () => inlineExportPayload(HUGE, "no object store is configured"),
      "a payload that clears the row cap by compressing well was accepted",
    ).toThrow(/uncompressed|output/i);
  });

  it("REFUSES to read one that was written anyway", () => {
    // The write guard protects this deployment's own rows. The read guard protects it from a row it did not
    // write — an older writer, a restored backup, a different version — and it is the one that runs inside
    // the reconciler, which is where the cost lands.
    const smuggled = {
      kind: "inline" as const,
      encoding: "gzip+base64" as const,
      bytes: gzipSync(Buffer.from(JSON.stringify(HUGE), "utf8")).toString("base64"),
      reason: "written by a version that had no output bound",
    };
    expect(smuggled.bytes.length, "this fixture does not actually clear the row cap").toBeLessThan(
      INLINE_EXPORT_PAYLOAD_CAP_BYTES,
    );
    expect(
      () => readExportPayload(smuggled),
      "a row whose bytes decompress past the bound was expanded anyway",
    ).toThrow(/uncompressed|output/i);
  });

  it("still round-trips an ordinary settlement", () => {
    // The bound must not become a refusal of the payloads it exists to carry.
    const ordinary = { caseId: "c1", scores: [{ graderId: "g", metric: "tests_pass", value: 1 }] };
    expect(readExportPayload(inlineExportPayload(ordinary, "no object store is configured"))).toEqual(ordinary);
  });

  it("bounds the OUTPUT well above any real settlement, and below what stalls a reconciler", () => {
    // Stated as a property rather than a number nobody can weigh: a scorecard's export payload is scores and
    // identifiers, and the reconciler shares a process with every other owed publication.
    expect(INLINE_EXPORT_PAYLOAD_MAX_OUTPUT_BYTES).toBeGreaterThan(INLINE_EXPORT_PAYLOAD_CAP_BYTES);
    expect(INLINE_EXPORT_PAYLOAD_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
