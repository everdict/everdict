import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BrowserWindow, Menu, Tray, app, nativeImage, shell } from "electron";
import { type ConfigIo, type DesktopConfig, loadConfig, saveConfig } from "./config-store.js";
import { buildTrayMenuTemplate } from "./tray-menu.js";
import { allowTopLevelNavigation, decideWindowOpen, webOriginOf } from "./window-policy.js";

// 데스크톱 셸 — 배포된 웹을 그대로 렌더링(D1: UI SSOT = apps/web)하고, 트레이에 상주한다.
// 설계: docs/architecture/desktop-app.md · 규약: .claude/skills/desktop/SKILL.md.
const webUrl = process.env.ASSAY_WEB_URL ?? "http://localhost:3000";
const webOrigin = webOriginOf(webUrl);

// 스킬 desktop 보안 불변식 2 — 모든 창에 항상 이 webPreferences.
const secureWebPreferences = { contextIsolation: true, nodeIntegration: false, sandbox: true } as const;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// userData 의 config.json 에 비-비밀 설정 저장(자동시작 등). rnr_ 토큰은 여기 절대 금지(불변식 5).
function configIo(): ConfigIo {
  const dir = app.getPath("userData");
  const file = path.join(dir, "config.json");
  return {
    read: () => (existsSync(file) ? readFileSync(file, "utf8") : null),
    write: (text) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text);
    },
  };
}

let config: DesktopConfig;

function applyAutostart(next: boolean): void {
  config = { ...config, autostart: next };
  saveConfig(configIo(), config);
  // macOS/Windows 만 지원(Linux 는 Electron 이 no-op) — 패키징 슬라이스에서 .desktop autostart 로 보완.
  app.setLoginItemSettings({ openAtLogin: next });
  refreshTrayMenu();
}

function createOrFocusWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: { ...secureWebPreferences },
  });
  // window.open: 웹 origin 만 앱 새 창, 그 외 http/https 는 시스템 브라우저(정책 근거는 window-policy.ts 주석).
  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, webOrigin);
    if (decision === "external") void shell.openExternal(url);
    if (decision !== "in-app") return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { ...secureWebPreferences } } };
  });
  // 탑레벨 네비게이션: http/https 만 허용(OIDC/OAuth 리다이렉트 경유), 그 외 스킴 차단.
  win.webContents.on("will-navigate", (event, url) => {
    if (!allowTopLevelNavigation(url)) event.preventDefault();
  });
  // 닫기 = 트레이로 숨김(러너 상주 유지). 종료는 트레이 메뉴에서만.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    mainWindow = null;
  });
  void win.loadURL(webUrl);
  mainWindow = win;
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate(
      buildTrayMenuTemplate(
        { autostart: config.autostart },
        {
          openApp: () => createOrFocusWindow(),
          setAutostart: (next) => applyAutostart(next),
          quit: () => {
            quitting = true;
            app.quit();
          },
        },
      ),
    ),
  );
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), "assets", "tray.png"));
  tray = new Tray(icon);
  tray.setToolTip("Assay");
  tray.on("click", () => createOrFocusWindow());
  refreshTrayMenu();
}

// 단일 인스턴스 — 두 번째 실행은 기존 창을 앞으로.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => createOrFocusWindow());

  void app.whenReady().then(() => {
    config = loadConfig(configIo());
    createTray();
    createOrFocusWindow();
  });

  // 모든 창이 닫혀도 종료하지 않는다 — 트레이 상주(이후 슬라이스에서 러너가 백그라운드로 돈다).
  app.on("window-all-closed", () => {
    /* 트레이 상주 */
  });
  app.on("activate", () => createOrFocusWindow()); // macOS dock 클릭
  app.on("before-quit", () => {
    quitting = true;
  });
}
