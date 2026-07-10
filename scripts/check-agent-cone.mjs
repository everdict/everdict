#!/usr/bin/env node
// 슬림 agent 이미지 가드 (re-architecture P0).
// @everdict/agent 의 workspace 의존성 콘(cone)을 전이적으로 걷어서 세 가지 불변식을 검사한다:
//   (1) 콘 멤버는 전부 허용 목록 안이어야 한다 — 컨트롤플레인 패키지(db/auth/backends…)가
//       agent 이미지에 끌려 들어오면 이미지가 다시 비대해진다.
//   (2) 콘 멤버는 "pg" 나 컨트롤플레인 @everdict/* 패키지에 의존할 수 없다 — DB 드라이버/
//       오케스트레이션 계층은 샌드박스 안에서 실행될 이유가 없다.
//   (3) @everdict/contracts(L0) 의 dependencies 는 정확히 {"zod"} — 계약 루트는 영원히 가볍게.
// 위반 시 해당 엣지를 출력하고 exit 1. plain Node, 외부 의존성 없음.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// agent 이미지에 들어가도 되는 패키지 전부 (packages/<name> 의 비스코프 이름).
const ALLOWLIST = new Set([
  "agent",
  "contracts",
  "core",
  "drivers",
  "environments",
  "graders",
  "harnesses",
  "run-case",
  "trace",
]);

// 콘 멤버가 절대 의존하면 안 되는 컨트롤플레인 패키지들.
const FORBIDDEN = new Set([
  "@everdict/db",
  "@everdict/auth",
  "@everdict/registry",
  "@everdict/backends",
  "@everdict/orchestrator",
  "@everdict/suite",
  "@everdict/topology",
  "@everdict/sdk",
  "@everdict/billing",
  "@everdict/datasets",
  "@everdict/storage",
  "@everdict/self-hosted-runner",
]);

const SCOPE = "@everdict/";

// packages 디렉터리 이름 == 비스코프 패키지 이름 (모노레포 규약).
function readPackageJson(unscopedName) {
  const file = path.join(root, "packages", unscopedName, "package.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

const violations = [];
const cone = new Set(["agent"]);
const queue = ["agent"];

// BFS 로 workspace 의존성 콘을 계산하면서 엣지 단위로 검사한다.
while (queue.length > 0) {
  const name = queue.shift();
  const pkg = readPackageJson(name);
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const dep of deps) {
    if (dep === "pg") {
      violations.push(`${SCOPE}${name} -> pg (DB 드라이버는 agent 콘 밖이어야 한다)`);
      continue;
    }
    if (FORBIDDEN.has(dep)) {
      violations.push(`${SCOPE}${name} -> ${dep} (컨트롤플레인 패키지 — agent 콘 진입 금지)`);
      continue;
    }
    if (!dep.startsWith(SCOPE)) continue; // 서드파티는 pg 외에는 여기서 판정하지 않는다
    const unscoped = dep.slice(SCOPE.length);
    if (!ALLOWLIST.has(unscoped)) {
      violations.push(`${SCOPE}${name} -> ${dep} (허용 목록 밖 — 콘을 넓히려면 이 스크립트의 근거부터 갱신)`);
      continue;
    }
    if (!cone.has(unscoped)) {
      cone.add(unscoped);
      queue.push(unscoped);
    }
  }
}

// (3) L0 계약 루트는 정확히 zod 하나만 의존한다.
const contractsDeps = Object.keys(readPackageJson("contracts").dependencies ?? {}).sort();
if (contractsDeps.length !== 1 || contractsDeps[0] !== "zod") {
  violations.push(`@everdict/contracts dependencies = {${contractsDeps.join(", ")}} (정확히 {zod} 여야 한다)`);
}

if (violations.length > 0) {
  console.error("agent cone check FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`PASS agent cone: ${[...cone].sort().join(", ")}`);
