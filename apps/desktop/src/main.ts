import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { RunnerHost, detectCapabilities } from "@assay/runner-core";
import { BrowserWindow, Menu, Notification, Tray, app, ipcMain, nativeImage, safeStorage, shell } from "electron";
import electronUpdater from "electron-updater";
import {
  BRIDGE_CHANNELS,
  type DesktopAppInfo,
  type DesktopRunnerStatus,
  registerBridge,
  senderAllowed,
} from "./bridge.js";
import { type ConfigIo, type DesktopConfig, loadConfig, saveConfig } from "./config-store.js";
import { RunnerController } from "./runner-controller.js";
import { type TokenIo, clearToken, loadToken, saveToken } from "./token-store.js";
import { buildTrayMenuTemplate, runnerStatusLabel } from "./tray-menu.js";
import { type AutoUpdaterLike, UpdaterController, type UpdaterState } from "./updater.js";
import { allowTopLevelNavigation, decideWindowOpen, webOriginOf } from "./window-policy.js";

// 데스크톱 셸 — 배포된 웹을 그대로 렌더링(D1: UI SSOT = apps/web)하고, 트레이에 상주하며,
// 셀프호스티드 러너(@assay/runner-core)를 메인 프로세스에 내장한다(D3: 원클릭 페어링).
// 설계: docs/architecture/desktop-app.md · 규약: .claude/skills/desktop/SKILL.md.
const webUrl = process.env.ASSAY_WEB_URL ?? "http://localhost:3000";
const webOrigin = webOriginOf(webUrl);
// 러너의 컨트롤플레인 기본값 — 페어링 페이로드의 apiUrl 이 우선한다(웹 서버가 아는 CONTROL_PLANE_URL).
const defaultApiUrl = process.env.ASSAY_API_URL ?? "http://localhost:8787";

// 스킬 desktop 보안 불변식 2 — 모든 창에 항상 이 webPreferences. preload 는 origin 게이트(preload.cts)를 위해
// 웹 origin 을 인자로 받는다.
function securePreferences(): Electron.WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: path.join(import.meta.dirname, "preload.cjs"),
    additionalArguments: [`--assay-web-origin=${webOrigin}`],
  };
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shuttingDown = false;

// userData 의 config.json 에 비-비밀 설정 저장(자동시작·러너 메타). rnr_ 토큰은 여기 절대 금지(불변식 5).
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

// rnr_ 토큰의 safeStorage 암호문 파일 IO — token-store 가 암복호를 맡는다.
function tokenIo(): TokenIo {
  const dir = app.getPath("userData");
  const file = path.join(dir, "runner-token.bin");
  return {
    read: () => (existsSync(file) ? readFileSync(file) : null),
    write: (data) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, data);
    },
    remove: () => rmSync(file, { force: true }),
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

// 트레이/알림이 참조하는 최신 러너 상태 — broadcast 가 갱신한다.
let latestRunnerStatus: DesktopRunnerStatus = { paired: false, state: "off", activeJobs: 0, capabilities: [] };
// 드레인(running→idle) 단위 알림용 카운터 — 케이스마다 알리면 배치에서 스팸이 된다.
let doneSinceIdle = 0;
let failedSinceIdle = 0;

// running→idle 전이 시 1회 알림(성공/실패 집계) — Mattermost 완료 알림의 로컬판.
function notifyDrainIfNeeded(prev: DesktopRunnerStatus, next: DesktopRunnerStatus): void {
  if (prev.state !== "running" || next.state !== "idle" || doneSinceIdle + failedSinceIdle === 0) return;
  const body = `성공 ${doneSinceIdle} · 실패 ${failedSinceIdle}`;
  doneSinceIdle = 0;
  failedSinceIdle = 0;
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: "Assay 러너 — 잡 처리 완료", body });
    n.on("click", () => createOrFocusWindow());
    n.show();
  } catch {
    /* 알림 미지원 환경(libnotify 부재 등) — 무시 */
  }
}

// 러너 컨트롤러 — 페어 상태 영속 + RunnerHost 수명주기. 상태는 웹 origin 창에만 push(불변식 4와 같은 경계).
const controller = new RunnerController({
  loadToken: () => loadToken(safeStorage, tokenIo()),
  saveToken: (token) => saveToken(safeStorage, tokenIo(), token),
  clearToken: () => clearToken(tokenIo()),
  loadMeta: () => {
    const c = loadConfig(configIo());
    return {
      ...(c.runnerId !== undefined ? { runnerId: c.runnerId } : {}),
      ...(c.apiUrl !== undefined ? { apiUrl: c.apiUrl } : {}),
    };
  },
  saveMeta: (meta) => {
    const { runnerId: _r, apiUrl: _a, ...rest } = loadConfig(configIo());
    config = { ...rest, ...meta };
    saveConfig(configIo(), config);
  },
  makeHost: ({ token, apiUrl, onStatus }) =>
    new RunnerHost({
      token,
      apiUrl,
      onStatus,
      onJobDone: (done) => {
        if (done.error) failedSinceIdle++;
        else doneSinceIdle++;
      },
      log: (m) => console.error(m),
      // 데스크톱은 종료 지연을 줄이기 위해 long-poll 을 CLI(25s)보다 짧게 잡는다(정지는 현재 poll 완료까지 대기).
      waitMs: 8_000,
    }),
  defaultApiUrl,
  broadcast: (status) => {
    notifyDrainIfNeeded(latestRunnerStatus, status);
    latestRunnerStatus = status;
    refreshTrayMenu(); // 상태행·해제 항목·툴팁 동기화(tray 없으면 no-op)
    for (const win of BrowserWindow.getAllWindows()) {
      if (senderAllowed(win.webContents.getURL(), webOrigin)) win.webContents.send(BRIDGE_CHANNELS.statusEvent, status);
    }
  },
  log: (m) => console.error(m),
});

// 자동 업데이트(설계 D6) — 활성 게이트: 패키징된 앱 && 피드 구성. 피드 목적지(공개 releases 리포 vs
// 리포 public 전환)는 사용자 결정 대기 — 확정되면 electron-builder.yml 에 publish 블록을 추가하면
// app-update.yml 이 패키지에 실려 자동 활성된다. 그 전엔 ASSAY_UPDATE_FEED_URL(generic 디렉터리 URL)로
// 수동/검증 활성만 가능. dev(미패키징)는 항상 비활성.
function resolveAutoUpdater(): AutoUpdaterLike | null {
  if (!app.isPackaged) return null;
  const feedUrl = process.env.ASSAY_UPDATE_FEED_URL;
  if (feedUrl) {
    // setFeedURL 만으로는 부족 — AppImageUpdater 등이 다운로드 단계에서 app-update.yml(디스크 설정)을
    // 읽는다. env 활성화 시 userData 에 설정 파일을 써서 updateConfigPath 로 주입한다.
    const configPath = path.join(app.getPath("userData"), "app-update.yml");
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(configPath, `provider: generic\nurl: ${JSON.stringify(feedUrl)}\n`);
    electronUpdater.autoUpdater.updateConfigPath = configPath;
    return electronUpdater.autoUpdater;
  }
  if (existsSync(path.join(process.resourcesPath, "app-update.yml"))) return electronUpdater.autoUpdater;
  return null;
}

let updaterState: UpdaterState = { kind: "disabled" };
const updater = new UpdaterController({
  updater: resolveAutoUpdater(),
  onStatus: (state) => {
    const prev = updaterState;
    updaterState = state;
    if (state.kind !== prev.kind)
      console.error(`업데이트 상태: ${state.kind}${"version" in state ? ` v${state.version}` : ""}`);
    refreshTrayMenu();
    // ready 진입 시 1회 알림 — 적용(재시작)은 사용자가 트레이에서 결정한다(러너 잡 강제 중단 없음).
    if (state.kind === "ready" && prev.kind !== "ready") {
      try {
        if (Notification.isSupported()) {
          const n = new Notification({
            title: "Assay 업데이트 준비됨",
            body: `재시작하면 v${state.version} 로 업데이트됩니다. 트레이 메뉴에서 적용하세요.`,
          });
          n.on("click", () => createOrFocusWindow());
          n.show();
        }
      } catch {
        /* 알림 미지원 환경 — 무시 */
      }
    }
  },
  log: (m) => console.error(m),
});

// 업데이트 적용 — 러너를 우아하게 정리한 뒤 재시작·설치. before-quit 의 preventDefault 경로를 타지 않게
// 플래그를 먼저 세운다(설치가 중간에 취소되지 않도록).
function applyUpdateNow(): void {
  quitting = true;
  shuttingDown = true;
  void controller
    .shutdown()
    .catch(() => {})
    .finally(() => updater.quitAndInstall());
}

// appInfo — 원클릭 페어링의 라벨(호스트명)/OS/capability 소스. capability 프로브는 1회 캐시.
let capabilitiesPromise: Promise<string[]> | null = null;
async function appInfo(): Promise<DesktopAppInfo> {
  capabilitiesPromise ??= detectCapabilities();
  return {
    version: app.getVersion(),
    platform: process.platform,
    hostname: hostname(),
    capabilities: await capabilitiesPromise,
  };
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
    webPreferences: securePreferences(),
  });
  // window.open: 웹 origin 만 앱 새 창, 그 외 http/https 는 시스템 브라우저(정책 근거는 window-policy.ts 주석).
  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, webOrigin);
    if (decision === "external") void shell.openExternal(url);
    if (decision !== "in-app") return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: { webPreferences: securePreferences() } };
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
  tray.setToolTip(`Assay — ${runnerStatusLabel(latestRunnerStatus)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate(
      buildTrayMenuTemplate(
        { autostart: config.autostart, runner: latestRunnerStatus, updater: updaterState },
        {
          openApp: () => createOrFocusWindow(),
          setAutostart: (next) => applyAutostart(next),
          // 로컬 해제(토큰 폐기+정지) — 서버 레코드 revoke 는 웹 계정 페이지가 권위.
          unpairRunner: () => void controller.unpair().catch((e) => console.error(`러너 해제 실패: ${e}`)),
          applyUpdate: () => applyUpdateNow(),
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
  tray.on("click", () => createOrFocusWindow());
  refreshTrayMenu();
}

// 단일 인스턴스 — 두 번째 실행은 기존 창을 앞으로.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => createOrFocusWindow());

  void app.whenReady().then(() => {
    // Linux 키링 부재(headless 등): safeStorage 가 basic_text 백엔드로 떨어지면 명시 옵트인 없이는
    // isEncryptionAvailable()=false → 원클릭 페어링이 불가능해진다. VSCode 와 같은 폴백을 택한다 —
    // 난독화 수준임을 경고하고 옵트인. GNOME/KDE 키링이 있으면 실제 암호화 백엔드라 이 경로를 타지 않는다.
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
      safeStorage.setUsePlainTextEncryption(true);
      console.error("⚠ OS 키링이 없어 러너 토큰을 safeStorage basic_text(난독화)로 저장합니다 — 키링 설치를 권장.");
    }
    config = loadConfig(configIo());
    registerBridge(ipcMain, {
      webOrigin,
      appInfo,
      pair: (payload) => controller.pair(payload),
      unpair: () => controller.unpair(),
      status: () => controller.status(),
    });
    createTray();
    createOrFocusWindow();
    // 저장된 페어가 있으면 러너를 조용히 복원(로그인/창과 무관하게 상주).
    void controller.startFromStore().catch((e) => console.error(`러너 복원 실패: ${e}`));
    // 자동 업데이트 — 시작 시 1회 + 6시간 주기 체크(피드 미구성이면 no-op, 상태 disabled).
    updater.start();
  });

  // 모든 창이 닫혀도 종료하지 않는다 — 트레이 상주(러너가 백그라운드로 돈다).
  app.on("window-all-closed", () => {
    /* 트레이 상주 */
  });
  app.on("activate", () => createOrFocusWindow()); // macOS dock 클릭
  // 종료 — 진행 중 잡 회신까지 러너를 우아하게 정지(1회 preventDefault 후 재-quit).
  app.on("before-quit", (event) => {
    quitting = true;
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    void controller.shutdown().finally(() => app.quit());
  });
}
