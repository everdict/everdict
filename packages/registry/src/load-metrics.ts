import { readFileSync, readdirSync } from "node:fs";
import { MetricSpecSchema } from "@assay/core";
import { InMemoryMetricRegistry, type MetricRegistry } from "./metric-registry.js";
import { SHARED_TENANT } from "./registry.js";

// 디렉터리의 *.json metric 들을 레지스트리에 로드. 버전 관리되는 파일 = SSOT(GitOps).
// 기본 소유자는 SHARED_TENANT(first-party 기본 모델 — 모든 테넌트가 폴백으로 봄). into 를 주면 거기에 등록(Pg 시드 등).
export async function loadMetricDir(
  dir: string,
  opts: { into?: MetricRegistry; tenant?: string } = {},
): Promise<MetricRegistry> {
  const registry = opts.into ?? new InMemoryMetricRegistry();
  const tenant = opts.tenant ?? SHARED_TENANT;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    await registry.register(tenant, MetricSpecSchema.parse(raw));
  }
  return registry;
}
