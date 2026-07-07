import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CAPABILITY_DEFS, type CapabilityName } from "@everdict/core";

const run = promisify(execFile);

// docker 데몬 존재 여부 — 하위호환 export(기존 소비처). exec 는 테스트 주입점.
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

// 강격리(gVisor/Kata/Firecracker) 가능? — KVM(/dev/kvm) 존재하거나 docker runtimes 에 hardened 런타임이 있음.
// (윈도우 Hyper-V 정밀 탐지는 후속; 여기선 리눅스 KVM + docker hardened runtime.) 이 라벨은 힌트일 뿐,
// 실제 격리 강제는 컨트롤플레인 trust-zone(assertHardenedIsolation)이 한다 — label != enforcement.
async function probeSandbox(): Promise<boolean> {
  if (await fileExists("/dev/kvm")) return true;
  try {
    const { stdout } = await run("docker", ["info", "--format", "{{json .Runtimes}}"]);
    return /runsc|kata|gvisor|firecracker/i.test(String(stdout));
  } catch {
    return false;
  }
}

// Playwright 브라우저 설치 여부 — ms-playwright 캐시 디렉터리 존재로 판정(설치를 트리거하지 않는 가벼운 프로브).
function playwrightCacheDir(): string {
  const os = platform();
  if (os === "darwin") return home("Library", "Caches", "ms-playwright");
  if (os === "win32") return join(process.env.LOCALAPPDATA ?? home("AppData", "Local"), "ms-playwright");
  return home(".cache", "ms-playwright");
}

// 각 capability 의 실측 프로브 — 이 머신이 실제로 그 기능을 지원하는지. 전부 주입 가능(테스트/커스텀).
// Partial: 모든 capability 가 머신-로컬로 프로브되는 건 아니다(예: `topology` 는 오케스트레이터/런타임에서 파생되는
// 능력이지 로컬 바이너리 유무가 아님 — 셀프호스티드 러너의 topology 배치 게이트는 `docker` 로 판정). 미정의 프로브는
// detectCapabilities 에서 false 로 폴백해 광고하지 않는다.
export type CapabilityProbes = Partial<Record<CapabilityName, () => Promise<boolean>>>;

// 기본 프로브 — 이 머신을 실제로 훑는다. 유저는 아무것도 안 고르고, 러너가 켜질 때 자가-판정한다.
// (topology 는 로컬 프로브 없음 — 위 주석 참고. git/docker/browser/... 만 실측.)
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

// 러너 capability 자가-광고 — 어휘(CAPABILITY_DEFS)의 각 프로브를 실측해 지원하는 이름만 어휘 순으로 반환.
// CLI·데스크톱이 같은 판정을 쓴다(스킬 desktop: 러너 동작은 runner-core 한곳에만). 테스트는 probes 주입.
export async function detectCapabilities(probes: CapabilityProbes = defaultProbes): Promise<CapabilityName[]> {
  const names = Object.keys(CAPABILITY_DEFS) as CapabilityName[];
  const flags = await Promise.all(names.map((n) => (probes[n] ?? (() => Promise.resolve(false)))()));
  return names.filter((_, i) => flags[i]);
}
