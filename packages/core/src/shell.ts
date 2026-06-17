// 셸 인자 안전 인용 — 사용자 task/경로를 셸 명령에 끼워넣을 때 사용.
export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
