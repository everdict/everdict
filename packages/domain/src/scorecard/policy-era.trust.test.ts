import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERDICT_POLICY_V1,
  resolvePolicyResolution,
  verdictPolicyDigest,
  verdictPolicyIdentity,
} from "./verdict-policy.js";

// Trust suite (docs/trust-certification.md) — TRUST-17.
//
// The invariant: ONE POLICY DOCUMENT HAS ONE IDENTITY ACROSS DIGEST ERAS. A batch sealed in the FNV window
// and a batch sealed after the sha256 switch — both under the identical v1 ladder — must resolve, compare
// equal, and never read as a policy mismatch or a mixed trend. Why a fake cannot prove it: the era window is
// a REAL artifact of this repo's history (stamps written between the stamping commit and the sha256 switch),
// and the certification is that the real legacy sealer's bytes verify under today's dual-read — a mocked
// digest would test string equality, not the algorithm bridge.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

// The pre-sha256 sealer, reproduced verbatim — the stamp a real FNV-era batch carries.
function legacyFnvOf(document: unknown): string {
  const canonicalize = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (value !== null && typeof value === "object")
      return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  const text = canonicalize(document);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

describeTrust("TRUST-17 — FNV-era and sha256-era stamps of one document are ONE policy", () => {
  const fnvRef = { id: "authority-ladder", version: "1.0.0", digest: legacyFnvOf(DEFAULT_VERDICT_POLICY_V1) };
  const shaRef = { id: "authority-ladder", version: "1.0.0", digest: verdictPolicyDigest(DEFAULT_VERDICT_POLICY_V1) };

  it("both eras RESOLVE to the same frozen document", () => {
    const fnv = resolvePolicyResolution(fnvRef);
    const sha = resolvePolicyResolution(shaRef);
    expect(fnv.status).toBe("resolved");
    expect(sha.status).toBe("resolved");
    expect(fnv.status === "resolved" && sha.status === "resolved" && fnv.policy === sha.policy).toBe(true);
  });

  it("their comparison identity is EQUAL — the migration boundary never reads as a policy mismatch", () => {
    expect(fnvRef.digest).not.toBe(shaRef.digest); // the eras really differ on the wire …
    expect(verdictPolicyIdentity(fnvRef)).toBe(verdictPolicyIdentity(shaRef)); // … and identical in meaning
    expect(verdictPolicyIdentity(undefined)).toBe(verdictPolicyIdentity(fnvRef)); // unstamped pre-mig = the same v1 ladder
  });
});
