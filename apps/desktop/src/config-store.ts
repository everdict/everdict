import { z } from "zod";

// 데스크톱 앱의 비-비밀 설정(자동 시작 등). rnr_ 페어링 토큰은 절대 여기 두지 않는다 —
// safeStorage 암호화 저장 전용(슬라이스 3, 스킬 desktop 불변식 5).
export const DesktopConfigSchema = z.object({
  autostart: z.boolean().default(false),
  // 접속할 웹(서버) URL — 첫 실행 화면/트레이 '서버 주소 변경'에서 저장(D8). env/CI 기본값과의 우선순위는 server-url.ts.
  webUrl: z.string().url().optional(),
  // 페어된 러너의 비밀 아닌 메타 — 토큰은 절대 여기 아님(token-store/safeStorage).
  runnerId: z.string().min(1).optional(),
  apiUrl: z.string().url().optional(),
  // 독립 알림(N6) 커서 — 마지막 OS 발화 createdAt(ISO). 재시작 시 백로그 재발화 방지.
  notifyCursor: z.string().optional(),
});
export type DesktopConfig = z.infer<typeof DesktopConfigSchema>;

// 파일 IO 주입점 — main 이 userData 경로의 실제 fs 를 묶고, 테스트는 인메모리로 대체.
export interface ConfigIo {
  read(): string | null; // 파일 없으면 null
  write(text: string): void;
}

export function loadConfig(io: ConfigIo): DesktopConfig {
  const raw = io.read();
  if (raw === null) return DesktopConfigSchema.parse({});
  try {
    return DesktopConfigSchema.parse(JSON.parse(raw));
  } catch {
    // 손상된 설정 파일이 앱 기동을 막으면 안 된다 — 비밀 아닌 UI 설정이므로 기본값으로 복구.
    return DesktopConfigSchema.parse({});
  }
}

export function saveConfig(io: ConfigIo, config: DesktopConfig): void {
  io.write(`${JSON.stringify(config, null, 2)}\n`);
}
