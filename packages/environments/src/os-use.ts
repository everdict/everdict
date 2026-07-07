import {
  BadRequestError,
  type ComputeHandle,
  type EnvSpec,
  type Environment,
  type OsUseSnapshot,
} from "@everdict/core";

const DEFAULT_DISPLAY = ":99";
const DEFAULT_SHOT = "/tmp/everdict-screen.png";

// 데스크탑(OS) 컴퓨터-유즈 환경 — 에이전트가 화면을 보고 GUI 앱을 조작(OSWorld 류, 예: hermes-desktop).
// 데스크탑 컴퓨트 이미지(Xvfb + 앱) 안에서 동작: seed 가 setup(디스플레이/wm/앱 기동) 실행, snapshot 이 스크린샷 캡처.
// snapshot(compute) 는 spec 을 못 받으므로 seed 에서 받은 display/screenshot 설정을 인스턴스에 보관해 사용.
export class OsUseEnvironment implements Environment<OsUseSnapshot> {
  readonly kind = "os-use" as const;
  private display = DEFAULT_DISPLAY;
  private shotPath = DEFAULT_SHOT;
  private shotCmd = `scrot -o ${DEFAULT_SHOT}`;

  async seed(compute: ComputeHandle, spec: EnvSpec): Promise<void> {
    if (spec.kind !== "os-use") throw new BadRequestError("BAD_REQUEST", { kind: spec.kind });
    this.display = spec.display ?? DEFAULT_DISPLAY;
    this.shotPath = spec.screenshotPath ?? DEFAULT_SHOT;
    this.shotCmd = spec.screenshotCmd ?? `scrot -o ${this.shotPath}`;
    // 디스플레이/윈도우매니저/데스크탑 앱 기동(백그라운드 데몬은 setup 명령에서 & 로). DISPLAY 주입.
    for (const cmd of spec.setup ?? []) {
      await compute.exec(cmd, { env: { DISPLAY: this.display }, timeoutSec: 180 });
    }
  }

  async snapshot(compute: ComputeHandle): Promise<OsUseSnapshot> {
    await compute.exec(this.shotCmd, { env: { DISPLAY: this.display }, timeoutSec: 60 });
    // 스크린샷 PNG 를 base64 로 동봉(컴퓨트는 dispose → 결과 밖으로 운반). best-effort: 실패하면 빈 문자열.
    const shot = await compute.exec(`base64 -w0 '${this.shotPath.replace(/'/g, "'\\''")}'`, { timeoutSec: 60 });
    const screenshot = shot.exitCode === 0 ? shot.stdout.trim() : "";
    // 보이는 창 제목(best-effort: wmctrl 있으면). 없으면 빈 목록 — 1차 신호는 스크린샷.
    const w = await compute.exec("wmctrl -l 2>/dev/null | sed 's/^[^ ]* *[^ ]* *[^ ]* //' || true", {
      env: { DISPLAY: this.display },
    });
    const windows = w.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return { kind: "os-use", screenshotRef: this.shotPath, screenshot, windows };
  }
}
