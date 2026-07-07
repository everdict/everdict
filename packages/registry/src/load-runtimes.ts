import { readFileSync, readdirSync } from "node:fs";
import { RuntimeSpecSchema } from "@everdict/core";
import { SHARED_TENANT } from "./registry.js";
import { InMemoryRuntimeRegistry, type RuntimeRegistry } from "./runtime-registry.js";

// 디렉터리의 *.json Runtime 정의를 레지스트리에 로드. 버전 관리되는 파일 = SSOT(GitOps).
// 기본 소유자는 SHARED_TENANT(first-party 공용 런타임 — 모든 테넌트가 폴백으로 봄). into 를 주면 거기에 등록(Pg 시드 등).
export async function loadRuntimeDir(
  dir: string,
  opts: { into?: RuntimeRegistry; tenant?: string } = {},
): Promise<RuntimeRegistry> {
  const registry = opts.into ?? new InMemoryRuntimeRegistry();
  const tenant = opts.tenant ?? SHARED_TENANT;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    await registry.register(tenant, RuntimeSpecSchema.parse(raw));
  }
  return registry;
}
