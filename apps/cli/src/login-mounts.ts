import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DriverMount } from "@everdict/job-runner";

// ── WHICH MACHINE LOGINS A CONTAINERIZED JOB MAY SEE (docs/architecture/portable-harness-runtime.md) ──
//
// An agent CLI in a case image authenticates with the runner owner's own login — own-pays, no API key — and
// each CLI reads its configuration from its own environment variable. So the mount is one decision repeated
// per agent, and it was written twice inline before this: the codex arm shipped, the Claude Code arm did not
// exist, and a harness that could run in an image had no way to be authenticated there.
//
// Extracted because the decision is worth testing and the loop around it is not: it is opt-in (the flag), it
// is refused without Docker (there is no container to mount into), and it is refused when the directory is
// absent (mounting a path that does not exist creates an empty one and the CLI then reports itself logged
// out, which reads as an agent that failed its task).
//
// SECURITY: every arm is EXPLICIT OPT-IN, because the credential is exposed to the job container this runner
// runs — which is code the workspace supplied. A default-on mount would hand somebody else's evaluation the
// owner's login.
export interface LoginMount {
  flag: string; // the CLI flag that opts in
  home: () => string; // where the login lives on this machine
  target: string; // where the container sees it
  env: string; // the variable a harness sets to point the CLI at the mount
  label: string;
}

export const LOGIN_MOUNTS: readonly LoginMount[] = [
  {
    flag: "mount-codex-login",
    home: () => process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    target: "/codex",
    env: "CODEX_HOME",
    label: "codex",
  },
  {
    flag: "mount-claude-login",
    home: () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    target: "/claude",
    env: "CLAUDE_CONFIG_DIR",
    label: "claude",
  },
];

export interface LoginMountDecision {
  mounts: DriverMount[];
  notes: string[]; // what to tell the operator — one line per flag, granted or refused with the reason
}

// The decision, as a total function over what this machine looks like. `exists` is injected so a test can
// describe a machine rather than have one.
export function loginMountsFor(
  flags: ReadonlySet<string>,
  opts: { dockerOk: boolean; exists?: (path: string) => boolean },
): LoginMountDecision {
  const exists = opts.exists ?? existsSync;
  const mounts: DriverMount[] = [];
  const notes: string[] = [];
  for (const m of LOGIN_MOUNTS) {
    if (!flags.has(m.flag)) continue;
    const home = m.home();
    if (opts.dockerOk && exists(home)) {
      // rw: every one of these CLIs writes a token refresh and a lock file into its config directory.
      mounts.push({ source: home, target: m.target });
      notes.push(
        `▶ ${m.label} login mount: ${home} → ${m.target} (containerized jobs). Reference it via ${m.env}=${m.target} in the harness.`,
      );
    } else {
      notes.push(`⚠ --${m.flag}: ${opts.dockerOk ? `${home} not found` : "no docker"} → skipping mount.`);
    }
  }
  return { mounts, notes };
}
