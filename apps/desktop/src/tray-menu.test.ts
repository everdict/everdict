import { describe, expect, it, vi } from "vitest";
import { type TrayMenuActions, buildTrayMenuTemplate } from "./tray-menu.js";

function actions(): TrayMenuActions & { openApp: ReturnType<typeof vi.fn> } {
  return { openApp: vi.fn(), setAutostart: vi.fn(), quit: vi.fn() };
}

// click 은 electron 이 (menuItem, window, event) 로 부르지만 템플릿 빌더는 인자를 쓰지 않는다 — 무인자 호출로 검증.
function click(item: { click?: unknown }): void {
  (item.click as () => void)();
}

describe("buildTrayMenuTemplate", () => {
  it("열기/자동시작 토글/종료 항목을 노출한다", () => {
    const t = buildTrayMenuTemplate({ autostart: false }, actions());
    expect(t.map((i) => i.label ?? i.type)).toEqual([
      "Assay 열기",
      "separator",
      "로그인 시 자동 시작",
      "separator",
      "종료",
    ]);
  });

  it("자동시작 체크 상태를 반영하고, 클릭은 반전값으로 setAutostart 를 부른다", () => {
    const a = actions();
    const on = buildTrayMenuTemplate({ autostart: true }, a);
    expect(on[2]?.checked).toBe(true);
    click(on[2] ?? {});
    expect(a.setAutostart).toHaveBeenCalledWith(false);

    const off = buildTrayMenuTemplate({ autostart: false }, a);
    expect(off[2]?.checked).toBe(false);
    click(off[2] ?? {});
    expect(a.setAutostart).toHaveBeenCalledWith(true);
  });

  it("열기/종료 클릭이 액션을 호출한다", () => {
    const a = actions();
    const t = buildTrayMenuTemplate({ autostart: false }, a);
    click(t[0] ?? {});
    click(t[4] ?? {});
    expect(a.openApp).toHaveBeenCalledOnce();
    expect(a.quit).toHaveBeenCalledOnce();
  });
});
