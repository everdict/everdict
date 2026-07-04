import type { CapabilityName } from "./capability.js";
import type { EvalCase } from "./eval-case.js";

// 케이스가 실행에 요구하는 capability 파생 — 케이스 필드에서 결정(image/env.kind/source/placement.isolation).
// kind 별 강제 레이어로 흘러간다: functional → placement 게이트(functionalGate) · security(sandbox) → trust-zone.
// auth(login) 요구는 케이스가 아니라 런타임/하니스 선택에서 나오므로 여기서 파생하지 않는다(그 레이어가 처리).
// 설계: docs/architecture/self-hosted-runtime-and-runners.md.
export function requiredCapabilities(evalCase: EvalCase): CapabilityName[] {
  const req = new Set<CapabilityName>();
  if (evalCase.image) req.add("docker"); // 컨테이너 이미지 실행(case.image)
  const env = evalCase.env;
  if (env.kind === "repo") {
    if ("git" in env.source) req.add("git"); // 원격 git 소스만 git 필요(files/path 소스는 불필요)
  } else if (env.kind === "browser") {
    req.add("browser"); // Playwright 브라우저
  } else if (env.kind === "os-use") {
    req.add("computer-use"); // OS GUI 제어
  }
  if (evalCase.placement?.isolation) req.add("sandbox"); // 격리 요구(security — 강제는 trust-zone)
  return [...req];
}
