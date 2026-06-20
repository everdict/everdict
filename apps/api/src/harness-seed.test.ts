import { fileURLToPath } from "node:url";
import { InMemoryHarnessRegistry, loadHarnessDir } from "@assay/registry";
import { describe, expect, it } from "vitest";

// first-party 하니스 카탈로그(examples/harnesses)가 _shared 로 로드되는지 가드 — 시드 파일이 HarnessSpec 스키마에
// 맞는지(깨진 프리셋 회귀 방지) + main.ts seedSharedHarnesses 가 서빙하는 대상과 동일.
const HARNESS_DIR = fileURLToPath(new URL("../../../examples/harnesses", import.meta.url));

describe("first-party 하니스 카탈로그 시드", () => {
  it("examples/harnesses 의 모든 프리셋이 파싱되어 _shared 로 등록된다", async () => {
    const reg = await loadHarnessDir(HARNESS_DIR, { into: new InMemoryHarnessRegistry() });
    // _shared 시드라 임의 테넌트가 폴백으로 본다.
    const list = await reg.list("any-tenant");
    const ids = list.map((h) => h.id).sort();
    expect(ids).toContain("aider"); // command 하니스(선언형 CLI 에이전트)
    expect(ids).toContain("bu"); // service 하니스(토폴로지)
    expect(list.every((h) => h.owner === "_shared")).toBe(true);
  });

  it("command + service 두 kind 모두 시드에 존재한다", async () => {
    const reg = await loadHarnessDir(HARNESS_DIR, { into: new InMemoryHarnessRegistry() });
    const aider = await reg.get("t", "aider"); // 소유 없음 → _shared 폴백
    expect(aider.kind).toBe("command");
    const bu = await reg.get("t", "bu");
    expect(bu.kind).toBe("service");
  });
});
