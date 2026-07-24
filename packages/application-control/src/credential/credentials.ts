import { createHash, randomBytes } from "node:crypto";

// Credential primitives shared by the control plane's issuance/verification paths — moved from
// @everdict/db in re-architecture P2d (they are minting/hashing rules, not persistence; the stores
// only keep the hashes). One home: API keys (ak_), invite tokens (inv_), and the SHA-256 discipline
// that pairs them ("plaintext shown once, only the hash is stored").

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ak_<random> — plaintext key. Shown once at issuance, stored only as a hash.
export function generateKey(): string {
  return `ak_${randomBytes(24).toString("base64url")}`;
}

// inv_<random> — plaintext invite token (embedded in the link). Shown once at creation and stored only as a hash.
export function generateInviteToken(): string {
  return `inv_${randomBytes(24).toString("base64url")}`;
}

// agt_<random> — plaintext agent execution token (docs/architecture/agent-execution-auth.md). A teammate / proactive
// agent presents it for request-less turns; resolved by agentTokenAuthenticator to a Principal that acts AS its
// creator. Shown once at issuance, stored only as a hash — same SHA-256 discipline as ak_/inv_.
export function generateAgentToken(): string {
  return `agt_${randomBytes(24).toString("base64url")}`;
}
