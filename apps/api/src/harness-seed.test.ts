import { fileURLToPath } from "node:url";
import { loadDatasetDir, loadHarnessDir, loadRuntimeDir } from "@assay/registry";
import { InMemoryHarnessRegistry } from "@assay/registry";
import { describe, expect, it } from "vitest";

// first-party 하니스 카탈로그(examples/harnesses)가 _shared 로 로드되는지 가드 — 시드 파일이 HarnessSpec 스키마에
// 맞는지(깨진 프리셋 회귀 방지) + main.ts seedSharedHarnesses 가 서빙하는 대상과 동일.
const HARNESS_DIR = fileURLToPath(new URL("../../../examples/harnesses", import.meta.url));
const DATASET_DIR = fileURLToPath(new URL("../../../examples/datasets", import.meta.url));
const RUNTIME_DIR = fileURLToPath(new URL("../../../examples/runtimes", import.meta.url));

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

  it("os-use 데스크탑 에이전트(command, workDir) 가 시드에 있다", async () => {
    const reg = await loadHarnessDir(HARNESS_DIR, { into: new InMemoryHarnessRegistry() });
    const agent = await reg.get("t", "desktop-ssh-agent");
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
    expect(ds.cases.every((c) => c.placement?.target === "docker")).toBe(true);
    expect(ds.cases.every((c) => c.graders.some((g) => g.id === "judge" && g.config?.useScreenshot === true))).toBe(
      true,
    );
  });

  it("examples/runtimes 가 파싱되고 docker 런타임이 _shared 에 있다", async () => {
    const reg = await loadRuntimeDir(RUNTIME_DIR);
    const rt = await reg.get("any-tenant", "docker");
    expect(rt.kind).toBe("docker");
  });
});
