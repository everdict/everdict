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
  it("defaults when the file is absent", () => {
    expect(loadConfig(memoryIo())).toEqual({ autostart: false });
  });

  it("save → load round-trip", () => {
    const io = memoryIo();
    saveConfig(io, { autostart: true });
    expect(loadConfig(io)).toEqual({ autostart: true });
  });

  it("recovers to defaults on corrupt JSON / a schema mismatch (does not block startup)", () => {
    expect(loadConfig(memoryIo("{oops"))).toEqual({ autostart: false });
    expect(loadConfig(memoryIo('{"autostart":"yes"}'))).toEqual({ autostart: false });
  });
});
