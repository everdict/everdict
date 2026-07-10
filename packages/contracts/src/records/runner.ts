// Self-hosted runner record shapes — moved from @everdict/db runner-store in re-architecture P2c.
// The RunnerStore interface + impls + generateRunnerToken stay in @everdict/db.

// A personal device where a user paired their own machine with a workspace.
export interface RunnerMeta {
  id: string;
  label: string; // display device name (e.g. "ho-macbook")
  os?: string; // linux | darwin | win32 etc. (optional)
  capabilities: string[]; // repo | browser | os-use | docker — the environments this machine can run
  pairedAt: string;
  lastSeenAt?: string; // last lease/heartbeat time (refreshed via touch in a later slice)
}

// Pairing input — the plaintext token is hashed just before storage. The token is issued by the server (the client doesn't choose it).
export interface PairRunnerInput {
  owner: string; // runner owner = principal.subject (OIDC sub / api-key's key:<ws> / dev fallback "dev")
  workspace: string; // paired workspace — for the roster (listByWorkspace). Ownership is owner.
  label: string;
  os?: string;
  capabilities?: string[];
}

// Pairing result — token is plaintext (returned once, stored as a hash). The everdict runner authenticates to MCP with this token (later slice).
export interface PairedRunner {
  meta: RunnerMeta;
  token: string;
}

// Token → runner identification (used in the later slice's MCP auth/lease). Resolves to owner/workspace/runnerId.
export interface ResolvedRunner {
  owner: string;
  workspace: string;
  runnerId: string;
}
