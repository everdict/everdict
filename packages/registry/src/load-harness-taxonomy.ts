import { readFileSync, readdirSync } from "node:fs";
import { HarnessInstanceSpecSchema, HarnessTemplateSpecSchema } from "@everdict/core";
import { type HarnessInstanceRegistry, InMemoryHarnessInstanceRegistry } from "./harness-instance-registry.js";
import { type HarnessTemplateRegistry, InMemoryHarnessTemplateRegistry } from "./harness-template-registry.js";
import { SHARED_TENANT } from "./registry.js";

// 디렉터리에서 하네스 taxonomy 파일을 로드(파일 SSOT/GitOps). 파일명 규칙으로 구분:
//   *.template.json  → HarnessTemplateSpec (대분류 구조)
//   *.instance.json  → HarnessInstanceSpec (template 참조 + pins)
// 템플릿을 먼저 모두 등록한 뒤 인스턴스를 등록한다(인스턴스 등록이 템플릿을 resolve 로 검증하므로).
// 기본 소유자 = SHARED_TENANT(first-party 공유). into 를 주면 거기에(예: Pg*) 등록 — Postgres 시드.
export async function loadHarnessTaxonomyDir(
  dir: string,
  opts: { templates?: HarnessTemplateRegistry; instances?: HarnessInstanceRegistry; tenant?: string } = {},
): Promise<{ templates: HarnessTemplateRegistry; instances: HarnessInstanceRegistry }> {
  const templates = opts.templates ?? new InMemoryHarnessTemplateRegistry();
  const instances = opts.instances ?? new InMemoryHarnessInstanceRegistry(templates);
  const tenant = opts.tenant ?? SHARED_TENANT;
  const base = dir.replace(/\/$/, "");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const read = (f: string) => JSON.parse(readFileSync(`${base}/${f}`, "utf8"));

  for (const file of files.filter((f) => f.endsWith(".template.json"))) {
    await templates.register(tenant, HarnessTemplateSpecSchema.parse(read(file)));
  }
  for (const file of files.filter((f) => f.endsWith(".instance.json"))) {
    await instances.register(tenant, HarnessInstanceSpecSchema.parse(read(file)));
  }
  return { templates, instances };
}
