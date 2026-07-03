import type { MenuItemConstructorOptions } from "electron";

// 트레이 메뉴 템플릿 — 순수 빌더(electron 값 import 없음, 테스트 용이). 상태·액션은 main 이 주입한다.
export interface TrayMenuState {
  autostart: boolean;
}

export interface TrayMenuActions {
  openApp(): void;
  setAutostart(next: boolean): void;
  quit(): void;
}

export function buildTrayMenuTemplate(state: TrayMenuState, actions: TrayMenuActions): MenuItemConstructorOptions[] {
  return [
    { label: "Assay 열기", click: () => actions.openApp() },
    { type: "separator" },
    {
      label: "로그인 시 자동 시작",
      type: "checkbox",
      checked: state.autostart,
      click: () => actions.setAutostart(!state.autostart),
    },
    { type: "separator" },
    { label: "종료", click: () => actions.quit() },
  ];
}
