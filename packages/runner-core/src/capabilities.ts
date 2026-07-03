import { execFile } from "node:child_process";
import { promisify } from "node:util";

// docker 데몬 존재 여부 — service(topology) 하니스 실행 가능성의 근거. exec 는 테스트 주입점.
export async function probeDocker(
  exec: (cmd: string, args: string[]) => Promise<unknown> = promisify(execFile),
): Promise<boolean> {
  try {
    await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

// 러너 capability 자가-광고 — CLI·데스크톱이 같은 판정을 쓴다(스킬 desktop: 러너 동작은 runner-core 한곳에만).
export async function detectCapabilities(probe: () => Promise<boolean> = probeDocker): Promise<string[]> {
  const dockerOk = await probe();
  return ["repo", ...(dockerOk ? ["docker", "browser"] : [])];
}
