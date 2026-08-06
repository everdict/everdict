import { BadRequestError } from "@everdict/contracts";

// The agents' cross-conversation memory area (see the agent host's Memory section + workspaceMemoryPreamble).
export function isMemoryPath(path: string): boolean {
  const normalized = path.replace(/^\/+/, "");
  return normalized === "memory" || normalized.startsWith("memory/");
}

// Conservative, named credential shapes — precision over recall (a missed exotic token is the prompt discipline's
// job; a false positive here blocks a legitimate memory). Each entry names what the error reports.
const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "workspace API key (ak_…)", pattern: /\bak_[A-Za-z0-9]{16,}\b/ },
  { name: "runner token (rnr_…)", pattern: /\brnr_[A-Za-z0-9]{16,}\b/ },
  { name: "provider API key (sk-…)", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", pattern: /\b(?:ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{20,}\b/ },
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", pattern: /\bxox[bap]-[A-Za-z0-9-]{10,}\b/ },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function findSecretLikeToken(content: string): string | undefined {
  return SECRET_PATTERNS.find((p) => p.pattern.test(content))?.name;
}

// Memory is workspace-shared prose that gets REPLAYED into future agent contexts — a credential written there once
// would be re-surfaced forever, to every member and every agent. Scoped to memory/ on purpose: elsewhere on the
// tree a token-looking string can be legitimate data (a fixture, a doc about token formats); in a memory file it
// is always a mistake.
//
// The check lives on the bytes, at the moment they are published, so it holds for whoever is writing — the HTTP
// route, the agent's write_file, the turn-end memory extractor, a content projection, or a future caller nobody
// has written yet. Binary data is skipped: it decodes to replacement characters rather than a token, and a
// memory that is not prose is not the thing this protects.
export function assertNoSecretsInMemory(path: string, data: Uint8Array): void {
  if (!isMemoryPath(path)) return;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return; // not text — nothing a credential scan can read
  }
  const leak = findSecretLikeToken(text);
  if (leak === undefined) return;
  throw new BadRequestError(
    "BAD_REQUEST",
    { path, match: leak },
    `memory files are shared with the whole workspace and replayed into future conversations — never store credentials in them (found a ${leak}). Reference the secret by NAME (Settings › Secrets) instead.`,
  );
}
