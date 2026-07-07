// Store the rnr_ pairing token — safeStorage-encrypted file only (skill desktop invariant 5). No plaintext/config-file storage,
// no logging, never returned to the renderer (pairRunner is write-down-only).
export interface CipherLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface TokenIo {
  read(): Buffer | null; // null if the file is absent
  write(data: Buffer): void;
  remove(): void;
}

export function saveToken(cipher: CipherLike, io: TokenIo, token: string): void {
  if (!token.startsWith("rnr_")) throw new Error("Not an rnr_ pairing token.");
  if (!cipher.isEncryptionAvailable())
    throw new Error("Cannot store the pairing token — OS secure storage (safeStorage) is unavailable.");
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
    // Decryption failed (e.g. the OS keychain changed) — treat as unpaired to prompt re-pairing (does not block startup).
    return null;
  }
}

export function clearToken(io: TokenIo): void {
  io.remove();
}
