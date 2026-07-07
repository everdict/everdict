import { fileURLToPath } from "node:url";
import { loadDatasetDir, loadHarnessTaxonomyDir, loadRuntimeDir } from "@everdict/registry";
import { describe, expect, it } from "vitest";

// first-party 하네스 taxonomy(examples/harness-templates)가 _shared 로 로드되는지 가드 — 템플릿+인스턴스가
// 스키마에 맞고 resolve 되는지(깨진 프리셋 회귀 방지) + main.ts seedSharedHarnessTaxonomy 가 서빙하는 대상과 동일.
const HARNESS_DIR = fileURLToPath(new URL("../../../examples/harness-templates", import.meta.url));
const DATASET_DIR = fileURLToPath(new URL("../../../examples/datasets", import.meta.url));
const RUNTIME_DIR = fileURLToPath(new URL("../../../examples/runtimes", import.meta.url));

describe("first-party 하네스 taxonomy 시드", () => {
  it("examples/harness-templates 의 템플릿+인스턴스가 _shared 로 로드되어 resolve 된다", async () => {
    const { instances } = await loadHarnessTaxonomyDir(HARNESS_DIR);
    const list = await instances.list("any-tenant"); // _shared 폴백
    const ids = list.map((h) => h.id).sort();
    expect(ids).toContain("aider"); // command 인스턴스(선언형 CLI 에이전트)
    expect(ids).toContain("bu"); // service 인스턴스(토폴로지)
    expect(list.every((h) => h.owner === "_shared")).toBe(true);
  });

  it("command + service 두 kind 모두 resolve 된다", async () => {
    const { instances } = await loadHarnessTaxonomyDir(HARNESS_DIR);
    const aider = await instances.get("t", "aider"); // 소유 없음 → _shared 폴백
    expect(aider.kind).toBe("command");
    const bu = await instances.get("t", "bu");
    expect(bu.kind).toBe("service");
  });

  it("os-use 데스크탑 에이전트(command, workDir) 인스턴스가 resolve 된다", async () => {
    const { instances } = await loadHarnessTaxonomyDir(HARNESS_DIR);
    const agent = await instances.get("t", "desktop-ssh-agent");
    expect(agent.kind).toBe("command");
    expect(agent.kind === "command" && agent.workDir).toBe("/tmp"); // os-use 는 work 가 없어 절대경로 필요
  });
});

// first-party 데이터셋/런타임 카탈로그도 스키마에 맞게 로드되는지 가드(seedSharedDatasets/Runtimes 가 서빙).
describe("first-party 데이터셋·런타임 카탈로그 시드", () => {
  it("examples/datasets 가 파싱되고 os-use 벤치마크(hermes-desktop-ssh, 멀티케이스)가 _shared 에 있다", async () => {
    const reg = await loadDatasetDir(DATASET_DIR);
    const ds = await reg.get("any-tenant", "hermes-desktop-ssh"); // _shared 폴백
    expect(ds.cases.length).toBeGreaterThanOrEqual(2); // 스코어카드 배치(여러 케이스)
    expect(ds.cases.map((c) => c.id)).toEqual(["hermes-ssh-connect", "hermes-open-settings"]);
    expect(ds.cases.every((c) => c.env.kind === "os-use")).toBe(true);
    expect(ds.cases.every((c) => c.image === "everdict-hermes-dispatch:demo")).toBe(true); // image 가 컨테이너 실행을 구동(런타임은 제출 시 선택)
    expect(ds.cases.every((c) => c.graders.some((g) => g.id === "judge" && g.config?.useScreenshot === true))).toBe(
      true,
    );
  });

  // 참고용 예제(자동 시드 아님 — 런타임은 워크스페이스가 직접 등록): 파일이 스키마에 맞게 파싱되는지만 보장.
  it("examples/runtimes 예제 파일이 파싱된다(참고용 — 자동 시드 없음)", async () => {
    const reg = await loadRuntimeDir(RUNTIME_DIR);
    const rt = await reg.get("any-tenant", "local");
    expect(rt.kind).toBe("local");
  });
});
