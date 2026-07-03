// rnr_ 페어링 토큰 저장 — safeStorage 암호화 파일 전용(스킬 desktop 불변식 5). 평문/설정 파일 저장 금지,
// 로그 금지, 렌더러로 되돌려주지 않는다(pairRunner 는 write-down-only).
export interface CipherLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface TokenIo {
  read(): Buffer | null; // 파일 없으면 null
  write(data: Buffer): void;
  remove(): void;
}

export function saveToken(cipher: CipherLike, io: TokenIo, token: string): void {
  if (!token.startsWith("rnr_")) throw new Error("rnr_ 페어링 토큰이 아닙니다.");
  if (!cipher.isEncryptionAvailable())
    throw new Error("OS 보안 저장소(safeStorage)를 쓸 수 없어 페어링 토큰을 저장할 수 없습니다.");
  io.write(cipher.encryptString(token));
}

export function loadToken(cipher: CipherLike, io: TokenIo): string | null {
  const data = io.read();
  if (data === null) return null;
  if (!cipher.isEncryptionAvailable()) return null;
  try {
    const token = cipher.decryptString(data);
    return token.startsWith("rnr_") ? token : null;
  } catch {
    // OS 키체인 변경 등으로 복호 실패 — 미페어 상태로 취급해 재페어링을 유도(기동은 막지 않는다).
    return null;
  }
}

export function clearToken(io: TokenIo): void {
  io.remove();
}
