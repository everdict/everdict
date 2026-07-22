// Self-hosted runner record shapes — moved from @everdict/db runner-store in re-architecture P2c.
// The RunnerStore interface + impls + generateRunnerToken stay in @everdict/db.

// Runner↔control-plane compatibility protocol version. The runner reports the value it was BUILT with (from its
// bundled @everdict/contracts) on every lease; the control plane compares it to the value IT was built with. A runner
// whose protocol is BELOW the control plane's is running older code than the server → it is told to update
// (`updateRequired`). Bump this ONLY on a breaking change to the runner-facing job/lease contract (e.g. CaseJobSchema
// tightening) — the same breakage the runner-loop's version-skew hint fires on. Monotonic; never reused.
export const RUNNER_PROTOCOL_VERSION = 1;

// A short, self-reported liveness note from the runner (why it can / can't do work right now). Carried on the runner's
// lease/heartbeat and overlaid on the roster read (never persisted — a restart re-fills it on the next lease). The
// level drives the roster's health color so an "online but stuck" runner (docker daemon down, image pull failing) is
// distinguishable from a healthy idle one at a glance.
export interface RunnerLiveStatus {
  text: string; // e.g. "idle", "running 2 job(s)", "no Docker daemon", "image pull failed: …"
  level: "info" | "warn" | "error";
  at: string; // ISO time the runner reported it
}

// A personal device where a user paired their own machine with a workspace.
export interface RunnerMeta {
  id: string;
  label: string; // display device name (e.g. "ho-macbook")
  os?: string; // linux | darwin | win32 etc. (optional)
  capabilities: string[]; // repo | browser | os-use | docker — the environments this machine can run
  pairedAt: string;
  lastSeenAt?: string; // last lease/heartbeat time (refreshed via touch in a later slice)
  version?: string; // runner build/app version (display only) — self-reported on lease; absent for a pre-version runner
  protocol?: number; // runner protocol version (see RUNNER_PROTOCOL_VERSION) — self-reported on lease; absent for a pre-version runner
  updateRequired?: boolean; // DERIVED on read (never stored): the runner's protocol is behind the control plane → update it
  status?: RunnerLiveStatus; // OVERLAID on read (never stored): the runner's self-reported live status/last-error (diagnosability)
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
