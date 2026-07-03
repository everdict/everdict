import { describe, expect, it } from "vitest";
import { type ConfigIo, loadConfig, saveConfig } from "./config-store.js";

function memoryIo(initial: string | null = null): ConfigIo & { text: string | null } {
  const io = {
    text: initial,
    read: () => io.text,
    write: (t: string) => {
      io.text = t;
    },
  };
  return io;
}

describe("config-store", () => {
  it("파일이 없으면 기본값", () => {
    expect(loadConfig(memoryIo())).toEqual({ autostart: false });
  });

  it("저장 → 로드 라운드트립", () => {
    const io = memoryIo();
    saveConfig(io, { autostart: true });
    expect(loadConfig(io)).toEqual({ autostart: true });
  });

  it("손상된 JSON/스키마 불일치는 기본값으로 복구(기동을 막지 않는다)", () => {
    expect(loadConfig(memoryIo("{oops"))).toEqual({ autostart: false });
    expect(loadConfig(memoryIo('{"autostart":"yes"}'))).toEqual({ autostart: false });
  });
});
