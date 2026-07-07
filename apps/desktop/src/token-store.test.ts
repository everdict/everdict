import { describe, expect, it } from "vitest";
import { type CipherLike, type TokenIo, clearToken, loadToken, saveToken } from "./token-store.js";

// A fake cipher at the XOR level — substitutes the real safeStorage (verifies the path, not cryptographic strength).
function fakeCipher(available = true): CipherLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => {
      const t = b.toString();
      if (!t.startsWith("enc:")) throw new Error("bad");
      return t.slice(4);
    },
  };
}

function memoryIo(): TokenIo & { data: Buffer | null } {
  const io = {
    data: null as Buffer | null,
    read: () => io.data,
    write: (d: Buffer) => {
      io.data = d;
    },
    remove: () => {
      io.data = null;
    },
  };
  return io;
}

describe("token-store", () => {
  it("save → load round-trip — what is stored is ciphertext that went through the cipher", () => {
    const io = memoryIo();
    saveToken(fakeCipher(), io, "rnr_abc");
    expect(io.data?.toString().startsWith("enc:")).toBe(true); // via encryptString (not a plaintext direct write)
    expect(loadToken(fakeCipher(), io)).toBe("rnr_abc");
  });

  it("rejects saving a non-rnr_ token", () => {
    expect(() => saveToken(fakeCipher(), memoryIo(), "ak_notrunner")).toThrow(/rnr_/);
  });

  it("rejects saving when safeStorage is unavailable (no plaintext fallback)", () => {
    expect(() => saveToken(fakeCipher(false), memoryIo(), "rnr_abc")).toThrow(/safeStorage/);
  });

  it("returns null on decryption failure / missing file / unavailable environment (treated as unpaired, does not block startup)", () => {
    const io = memoryIo();
    expect(loadToken(fakeCipher(), io)).toBeNull();
    io.write(Buffer.from("garbage"));
    expect(loadToken(fakeCipher(), io)).toBeNull();
    saveToken(fakeCipher(), io, "rnr_abc");
    expect(loadToken(fakeCipher(false), io)).toBeNull();
  });

  it("clearToken removes the stored token", () => {
    const io = memoryIo();
    saveToken(fakeCipher(), io, "rnr_abc");
    clearToken(io);
    expect(loadToken(fakeCipher(), io)).toBeNull();
  });
});
