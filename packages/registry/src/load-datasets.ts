import { readFileSync, readdirSync } from "node:fs";
import { DatasetSchema } from "@assay/core";
import { type DatasetRegistry, InMemoryDatasetRegistry } from "./dataset-registry.js";
import { SHARED_TENANT } from "./registry.js";

// 디렉터리의 *.json 데이터셋들을 레지스트리에 로드. 버전 관리되는 파일 = SSOT(GitOps).
// 기본 소유자는 SHARED_TENANT(first-party 벤치마크 — 모든 테넌트가 폴백으로 봄). into 를 주면 거기에 등록(Pg 시드 등).
export async function loadDatasetDir(
  dir: string,
  opts: { into?: DatasetRegistry; tenant?: string } = {},
): Promise<DatasetRegistry> {
  const registry = opts.into ?? new InMemoryDatasetRegistry();
  const tenant = opts.tenant ?? SHARED_TENANT;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    await registry.register(tenant, DatasetSchema.parse(raw));
  }
  return registry;
}
