import { readFileSync, readdirSync } from "node:fs";
import { HarnessSpecSchema } from "@assay/core";
import { type HarnessRegistry, InMemoryHarnessRegistry } from "./registry.js";

// 디렉터리의 *.json 하니스 스펙들을 로드 → 레지스트리. 버전 관리되는 파일이 SSOT(GitOps).
// 각 파일은 하나의 HarnessSpec(process | service). 외부 입력이라 Zod 로 검증한다.
export function loadHarnessDir(dir: string): HarnessRegistry {
  const registry = new InMemoryHarnessRegistry();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    registry.register(HarnessSpecSchema.parse(raw));
  }
  return registry;
}
