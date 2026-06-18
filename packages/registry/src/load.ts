import { readFileSync, readdirSync } from "node:fs";
import { HarnessSpecSchema } from "@assay/core";
import { type HarnessRegistry, InMemoryHarnessRegistry } from "./registry.js";

// 디렉터리의 *.json 하니스 스펙들을 레지스트리에 로드. 버전 관리되는 파일이 SSOT(GitOps).
// 각 파일은 하나의 HarnessSpec(process | service). 외부 입력이라 Zod 로 검증한다.
// 대상 레지스트리를 주면(예: PgHarnessRegistry) 거기에 등록 — 파일을 Postgres 로 시드할 때 유용.
export async function loadHarnessDir(dir: string, into?: HarnessRegistry): Promise<HarnessRegistry> {
  const registry = into ?? new InMemoryHarnessRegistry();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    await registry.register(HarnessSpecSchema.parse(raw));
  }
  return registry;
}
