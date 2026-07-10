import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CAPABILITY_DEFS, type CapabilityName } from "@everdict/contracts";

const run = promisify(execFile);

// Whether the docker daemon exists — backward-compat export (existing consumers). exec is the test injection point.
export async function probeDocker(exec: (cmd: string, args: string[]) => Promise<unknown> = run): Promise<boolean> {
  try {
    await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

const cmdOk = async (cmd: string, args: string[]): Promise<boolean> => {
  try {
    await run(cmd, args);
    return true;
  } catch {
    return false;
  }
};
const fileExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
const home = (...p: string[]): string => join(homedir(), ...p);

// Strong isolation (gVisor/Kata/Firecracker) available? — either KVM (/dev/kvm) exists or docker runtimes include a hardened runtime.
// (Precise Windows Hyper-V detection is a follow-up; here it's Linux KVM + docker hardened runtime.) This label is only a hint —
// actual isolation enforcement is done by the control-plane trust-zone (assertHardenedIsolation) — label != enforcement.
async function probeSandbox(): Promise<boolean> {
  if (await fileExists("/dev/kvm")) return true;
  try {
    const { stdout } = await run("docker", ["info", "--format", "{{json .Runtimes}}"]);
    return /runsc|kata|gvisor|firecracker/i.test(String(stdout));
  } catch {
    return false;
  }
}

// Whether Playwright browsers are installed — decided by the existence of the ms-playwright cache directory (a light probe that doesn't trigger an install).
function playwrightCacheDir(): string {
  const os = platform();
  if (os === "darwin") return home("Library", "Caches", "ms-playwright");
  if (os === "win32") return join(process.env.LOCALAPPDATA ?? home("AppData", "Local"), "ms-playwright");
  return home(".cache", "ms-playwright");
}

// The measured probe for each capability — whether this machine actually supports that feature. All injectable (test/custom).
// Partial: not every capability is probed machine-locally (e.g. `topology` is a capability derived from the
// orchestrator/runtime, not the presence of a local binary — a self-hosted runner's topology placement gate decides on `docker`).
// An undefined probe falls back to false in detectCapabilities and isn't advertised.
export type CapabilityProbes = Partial<Record<CapabilityName, () => Promise<boolean>>>;

// The default probes — actually scan this machine. The user chooses nothing; the runner self-decides when it starts up.
// (topology has no local probe — see the comment above. Only git/docker/browser/... are measured.)
export const defaultProbes: CapabilityProbes = {
  git: () => cmdOk("git", ["--version"]),
  docker: () => probeDocker(),
  browser: () => fileExists(playwrightCacheDir()),
  "computer-use": async () =>
    platform() === "darwin" || platform() === "win32" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
  sandbox: () => probeSandbox(),
  "codex-login": () => fileExists(home(".codex", "auth.json")),
  "claude-login": () => fileExists(home(".claude.json")),
};

// Runner capability self-advertisement — measure each probe in the vocabulary (CAPABILITY_DEFS) and return only the supported names in vocabulary order.
// CLI and desktop use the same decision (skill desktop: runner behavior lives only in runner-core). Tests inject probes.
export async function detectCapabilities(probes: CapabilityProbes = defaultProbes): Promise<CapabilityName[]> {
  const names = Object.keys(CAPABILITY_DEFS) as CapabilityName[];
  const flags = await Promise.all(names.map((n) => (probes[n] ?? (() => Promise.resolve(false)))()));
  return names.filter((_, i) => flags[i]);
}
