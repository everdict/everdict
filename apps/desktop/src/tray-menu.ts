import type { MenuItemConstructorOptions } from "electron";
import type { DesktopRunnerStatus } from "./bridge.js";

// 트레이 메뉴 템플릿 — 순수 빌더(electron 값 import 없음, 테스트 용이). 상태·액션은 main 이 주입한다.
export interface TrayMenuState {
  autostart: boolean;
  runner: DesktopRunnerStatus;
}

export interface TrayMenuActions {
  openApp(): void;
  setAutostart(next: boolean): void;
  unpairRunner(): void;
  quit(): void;
}

// 러너 상태 한 줄 요약 — 트레이 상태행/툴팁 공용.
export function runnerStatusLabel(runner: DesktopRunnerStatus): string {
  if (!runner.paired) return "러너: 미페어 (계정 페이지에서 연결)";
  if (runner.state === "running") return `러너: 실행 중 (${runner.activeJobs})`;
  if (runner.state === "idle") return "러너: 온라인 대기";
  return "러너: 꺼짐";
}

export function buildTrayMenuTemplate(state: TrayMenuState, actions: TrayMenuActions): MenuItemConstructorOptions[] {
  return [
    { label: runnerStatusLabel(state.runner), enabled: false },
    { type: "separator" },
    { label: "Assay 열기", click: () => actions.openApp() },
    { type: "separator" },
    {
      label: "로그인 시 자동 시작",
      type: "checkbox",
      checked: state.autostart,
      click: () => actions.setAutostart(!state.autostart),
    },
    // 로컬 해제 — 이 기기의 토큰 폐기+러너 정지. 서버 쪽 러너 레코드 revoke 는 웹 계정 페이지가 권위.
    ...(state.runner.paired
      ? ([
          { label: "이 기기 러너 연결 해제", click: () => actions.unpairRunner() },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { type: "separator" },
    { label: "종료", click: () => actions.quit() },
  ];
}
