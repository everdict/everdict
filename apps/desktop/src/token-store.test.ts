import { describe, expect, it } from "vitest";
import { type CipherLike, type TokenIo, clearToken, loadToken, saveToken } from "./token-store.js";

// XOR 수준의 가짜 암호기 — 실제 safeStorage 대체(암호 강도가 아니라 경로를 검증).
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
  it("저장 → 로드 라운드트립 — 저장물은 cipher 를 통과한 암호문이다", () => {
    const io = memoryIo();
    saveToken(fakeCipher(), io, "rnr_abc");
    expect(io.data?.toString().startsWith("enc:")).toBe(true); // encryptString 경유(평문 직저장 아님)
    expect(loadToken(fakeCipher(), io)).toBe("rnr_abc");
  });

  it("rnr_ 가 아니면 저장 거부", () => {
    expect(() => saveToken(fakeCipher(), memoryIo(), "ak_notrunner")).toThrow(/rnr_/);
  });

  it("safeStorage 불가 시 저장 거부(평문 폴백 금지)", () => {
    expect(() => saveToken(fakeCipher(false), memoryIo(), "rnr_abc")).toThrow(/safeStorage/);
  });

  it("복호 실패/파일 없음/불가 환경은 null(미페어 취급, 기동은 막지 않음)", () => {
    const io = memoryIo();
    expect(loadToken(fakeCipher(), io)).toBeNull();
    io.write(Buffer.from("garbage"));
    expect(loadToken(fakeCipher(), io)).toBeNull();
    saveToken(fakeCipher(), io, "rnr_abc");
    expect(loadToken(fakeCipher(false), io)).toBeNull();
  });

  it("clearToken 은 저장분을 제거한다", () => {
    const io = memoryIo();
    saveToken(fakeCipher(), io, "rnr_abc");
    clearToken(io);
    expect(loadToken(fakeCipher(), io)).toBeNull();
  });
});
