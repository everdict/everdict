import { readFileSync, readdirSync } from "node:fs";
import { HarnessSpecSchema } from "@assay/core";
import { type HarnessRegistry, InMemoryHarnessRegistry, SHARED_TENANT } from "./registry.js";

// 디렉터리의 *.json 하니스 스펙들을 레지스트리에 로드. 버전 관리되는 파일 = SSOT(GitOps).
// 기본 소유자는 SHARED_TENANT(first-party 공유). tenant 를 주면 그 테넌트 소유로 등록.
// into 를 주면 거기에(예: PgHarnessRegistry) 등록 — 파일을 Postgres 로 시드할 때.
export async function loadHarnessDir(
  dir: string,
  opts: { into?: HarnessRegistry; tenant?: string } = {},
): Promise<HarnessRegistry> {
  const registry = opts.into ?? new InMemoryHarnessRegistry();
  const tenant = opts.tenant ?? SHARED_TENANT;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    await registry.register(tenant, HarnessSpecSchema.parse(raw));
  }
  return registry;
}
