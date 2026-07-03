// 프리로드 — window.assayDesktop 브리지의 렌더러 쪽 절반(스킬 desktop 불변식 3: 이 4개+구독이 전부).
// 채널 문자열은 bridge.ts BRIDGE_CHANNELS 와 수동 동기화(이 파일은 sandbox CJS 라 ESM 모듈을 import 못 한다).
// 1차 게이트: main 이 additionalArguments 로 넘긴 웹 origin 과 문서 origin 이 일치할 때만 노출 —
// 탑레벨 네비게이션이 Keycloak/GitHub 로 나가 있는 동안엔 브리지 자체가 없다. (실제 권한 경계는
// main 의 senderFrame origin 검사 — bridge.ts. 이중 방어.)
import electron = require("electron");

// sandbox preload 는 렌더러 문서 컨텍스트라 location 이 존재한다 — DOM lib 없는 tsconfig 라 최소 선언만.
declare const location: { origin: string };

const ORIGIN_FLAG = "--assay-web-origin=";
const expectedOrigin = process.argv.find((a) => a.startsWith(ORIGIN_FLAG))?.slice(ORIGIN_FLAG.length);

if (expectedOrigin !== undefined && location.origin === expectedOrigin) {
  electron.contextBridge.exposeInMainWorld("assayDesktop", {
    appInfo: () => electron.ipcRenderer.invoke("assay:app-info"),
    pairRunner: (payload: unknown) => electron.ipcRenderer.invoke("assay:pair-runner", payload),
    unpairRunner: () => electron.ipcRenderer.invoke("assay:unpair-runner"),
    runnerStatus: () => electron.ipcRenderer.invoke("assay:runner-status"),
    onRunnerStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: electron.IpcRendererEvent, status: unknown) => callback(status);
      electron.ipcRenderer.on("assay:runner-status-event", listener);
      return () => electron.ipcRenderer.removeListener("assay:runner-status-event", listener);
    },
  });
}
