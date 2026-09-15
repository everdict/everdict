import { describe, expect, it } from "vitest";
import { type CipherLike, type TokenIo, clearToken, loadToken, loadTokens, saveTokens } from "./token-store.js";

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

// The legacy single-token file — what an older desktop wrote before the multi-runner map. This desktop only reads
// and clears it (the migration into the map), so the fixture writes the ciphertext the way that version did.
function legacyTokenFile(token: string): TokenIo & { data: Buffer | null } {
  const io = memoryIo();
  io.write(fakeCipher().encryptString(token));
  return io;
}

describe("token-store (legacy single token)", () => {
  it("reads a legacy pairing back through the cipher", () => {
    expect(loadToken(fakeCipher(), legacyTokenFile("rnr_abc"))).toBe("rnr_abc");
  });

  it("returns null on decryption failure / missing file / unavailable environment (treated as unpaired, does not block startup)", () => {
    const io = memoryIo();
    expect(loadToken(fakeCipher(), io)).toBeNull();
    io.write(Buffer.from("garbage"));
    expect(loadToken(fakeCipher(), io)).toBeNull();
    expect(loadToken(fakeCipher(false), legacyTokenFile("rnr_abc"))).toBeNull();
  });

  it("does not hand back a legacy value that is not an rnr_ token", () => {
    expect(loadToken(fakeCipher(), legacyTokenFile("ak_notrunner"))).toBeNull();
  });

  it("clearToken removes the stored token", () => {
    const io = legacyTokenFile("rnr_abc");
    clearToken(io);
    expect(loadToken(fakeCipher(), io)).toBeNull();
  });
});

describe("token-store (multi-runner map)", () => {
  it("save → load round-trip preserves the whole { runnerId: token } map as ciphertext", () => {
    const io = memoryIo();
    saveTokens(fakeCipher(), io, { r1: "rnr_a", r2: "rnr_b" });
    expect(io.data?.toString().startsWith("enc:")).toBe(true);
    expect(loadTokens(fakeCipher(), io)).toEqual({ r1: "rnr_a", r2: "rnr_b" });
  });

  it("rejects saving a map with a non-rnr_ token", () => {
    expect(() => saveTokens(fakeCipher(), memoryIo(), { r1: "rnr_a", r2: "ak_bad" })).toThrow(/rnr_/);
  });

  it("rejects saving when safeStorage is unavailable (no plaintext fallback)", () => {
    expect(() => saveTokens(fakeCipher(false), memoryIo(), { r1: "rnr_a" })).toThrow(/safeStorage/);
  });

  it("returns an empty map on a missing file / corrupt data / unavailable environment (treated as no pairings)", () => {
    const io = memoryIo();
    expect(loadTokens(fakeCipher(), io)).toEqual({});
    io.write(Buffer.from("garbage"));
    expect(loadTokens(fakeCipher(), io)).toEqual({});
    saveTokens(fakeCipher(), io, { r1: "rnr_a" });
    expect(loadTokens(fakeCipher(false), io)).toEqual({});
  });
});
