import { describe, expect, it, vi } from "vitest";
import type { DesktopRunnerStatus } from "./bridge.js";
import { type TrayMenuActions, buildTrayMenuTemplate, runnerStatusLabel } from "./tray-menu.js";
import type { UpdaterState } from "./updater.js";

const OFF: DesktopRunnerStatus = { paired: false, state: "off", activeJobs: 0, capabilities: [] };
const IDLE: DesktopRunnerStatus = {
  paired: true,
  runnerId: "r1",
  state: "idle",
  activeJobs: 0,
  capabilities: ["repo"],
};
const BUSY: DesktopRunnerStatus = { ...IDLE, state: "running", activeJobs: 2 };
const NO_UPDATE: UpdaterState = { kind: "disabled" };

function actions(): TrayMenuActions & { openApp: ReturnType<typeof vi.fn> } {
  return {
    openApp: vi.fn(),
    setAutostart: vi.fn(),
    changeServerUrl: vi.fn(),
    unpairRunner: vi.fn(),
    applyUpdate: vi.fn(),
    quit: vi.fn(),
  };
}

// click 은 electron 이 (menuItem, window, event) 로 부르지만 템플릿 빌더는 인자를 쓰지 않는다 — 무인자 호출로 검증.
function click(item: { click?: unknown }): void {
  (item.click as () => void)();
}

describe("runnerStatusLabel", () => {
  it("미페어/대기/실행중(n) 을 구분한다", () => {
    expect(runnerStatusLabel(OFF)).toContain("미페어");
    expect(runnerStatusLabel(IDLE)).toBe("러너: 온라인 대기");
    expect(runnerStatusLabel(BUSY)).toBe("러너: 실행 중 (2)");
  });
});

describe("buildTrayMenuTemplate", () => {
  it("상태행(비활성)/열기/자동시작/종료 를 노출한다 — 미페어 시 해제 항목 없음", () => {
    const t = buildTrayMenuTemplate({ autostart: false, runner: OFF, updater: NO_UPDATE }, actions());
    expect(t[0]).toMatchObject({ enabled: false });
    expect(t.map((i) => i.label ?? i.type)).toEqual([
      runnerStatusLabel(OFF),
      "separator",
      "Assay 열기",
      "separator",
      "로그인 시 자동 시작",
      "서버 주소 변경…",
      "separator",
      "종료",
    ]);
  });

  it("페어 상태면 '이 기기 러너 연결 해제' 가 나타나고 클릭 시 unpairRunner", () => {
    const a = actions();
    const t = buildTrayMenuTemplate({ autostart: false, runner: IDLE, updater: NO_UPDATE }, a);
    const unpair = t.find((i) => i.label === "이 기기 러너 연결 해제");
    expect(unpair).toBeDefined();
    click(unpair ?? {});
    expect(a.unpairRunner).toHaveBeenCalledOnce();
  });

  it("자동시작 체크 상태를 반영하고, 클릭은 반전값으로 setAutostart 를 부른다", () => {
    const a = actions();
    const on = buildTrayMenuTemplate({ autostart: true, runner: OFF, updater: NO_UPDATE }, a);
    const toggle = on.find((i) => i.label === "로그인 시 자동 시작");
    expect(toggle?.checked).toBe(true);
    click(toggle ?? {});
    expect(a.setAutostart).toHaveBeenCalledWith(false);
  });

  it("업데이트 다운로드 중이면 비활성 진행 행, ready 면 적용 항목(클릭→applyUpdate)", () => {
    const a = actions();
    const downloading = buildTrayMenuTemplate(
      { autostart: false, runner: OFF, updater: { kind: "downloading", version: "9.9.9", percent: 42 } },
      a,
    );
    expect(downloading[0]).toMatchObject({ label: "업데이트 다운로드 중… (42%)", enabled: false });

    const ready = buildTrayMenuTemplate(
      { autostart: false, runner: OFF, updater: { kind: "ready", version: "9.9.9" } },
      a,
    );
    const apply = ready.find((i) => i.label === "v9.9.9 업데이트 적용 (재시작)");
    expect(apply).toBeDefined();
    click(apply ?? {});
    expect(a.applyUpdate).toHaveBeenCalledOnce();
  });

  it("'서버 주소 변경…' 클릭이 changeServerUrl 을 호출한다", () => {
    const a = actions();
    const t = buildTrayMenuTemplate({ autostart: false, runner: OFF, updater: NO_UPDATE }, a);
    click(t.find((i) => i.label === "서버 주소 변경…") ?? {});
    expect(a.changeServerUrl).toHaveBeenCalledOnce();
  });

  it("열기/종료 클릭이 액션을 호출한다", () => {
    const a = actions();
    const t = buildTrayMenuTemplate({ autostart: false, runner: OFF, updater: NO_UPDATE }, a);
    click(t.find((i) => i.label === "Assay 열기") ?? {});
    click(t.find((i) => i.label === "종료") ?? {});
    expect(a.openApp).toHaveBeenCalledOnce();
    expect(a.quit).toHaveBeenCalledOnce();
  });
});
