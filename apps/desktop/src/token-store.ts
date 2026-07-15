import { z } from "zod";

// Store the rnr_ pairing token(s) — safeStorage-encrypted file only (skill desktop invariant 5). No plaintext/config-file storage,
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

// --- Legacy single-token store (pre-multi) — kept only to read + migrate a pairing made by an older desktop. ---

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

// --- Multi-runner token store — one encrypted file holding a JSON map { runnerId: rnr_token } (skill desktop D9). ---

// A device can be paired as several independent runners; each keeps its own rnr_ token, keyed by the server-assigned runnerId.
const RunnerTokensSchema = z.record(z.string().min(1), z.string().startsWith("rnr_"));
export type RunnerTokens = z.infer<typeof RunnerTokensSchema>;

export function loadTokens(cipher: CipherLike, io: TokenIo): RunnerTokens {
  const data = io.read();
  if (data === null) return {};
  if (!cipher.isEncryptionAvailable()) return {};
  try {
    return RunnerTokensSchema.parse(JSON.parse(cipher.decryptString(data)));
  } catch {
    // Corrupt/undecryptable map (e.g. the OS keychain changed) — treat as no pairings (does not block startup).
    return {};
  }
}

export function saveTokens(cipher: CipherLike, io: TokenIo, tokens: RunnerTokens): void {
  for (const token of Object.values(tokens))
    if (!token.startsWith("rnr_")) throw new Error("Not an rnr_ pairing token.");
  if (!cipher.isEncryptionAvailable())
    throw new Error("Cannot store the pairing token — OS secure storage (safeStorage) is unavailable.");
  io.write(cipher.encryptString(JSON.stringify(tokens)));
}
