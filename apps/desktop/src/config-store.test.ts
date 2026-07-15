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
  it("defaults when the file is absent (no runners paired)", () => {
    expect(loadConfig(memoryIo())).toEqual({ autostart: false, runners: [] });
  });

  it("save → load round-trip", () => {
    const io = memoryIo();
    saveConfig(io, { autostart: true, runners: [] });
    expect(loadConfig(io)).toEqual({ autostart: true, runners: [] });
  });

  it("round-trips the multi-runner roster (D9 — several runners on one device)", () => {
    const io = memoryIo();
    saveConfig(io, {
      autostart: false,
      runners: [{ runnerId: "r1", apiUrl: "http://cp:8787", label: "laptop" }, { runnerId: "r2" }],
    });
    expect(loadConfig(io).runners).toEqual([
      { runnerId: "r1", apiUrl: "http://cp:8787", label: "laptop" },
      { runnerId: "r2" },
    ]);
  });

  it("preserves the legacy single-runner meta so it can be migrated (then dropped on next write)", () => {
    const io = memoryIo('{"autostart":false,"runnerId":"old","apiUrl":"http://cp:8787"}');
    const c = loadConfig(io);
    expect(c).toMatchObject({ runnerId: "old", apiUrl: "http://cp:8787", runners: [] });
  });

  it("recovers to defaults on corrupt JSON / a schema mismatch (does not block startup)", () => {
    expect(loadConfig(memoryIo("{oops"))).toEqual({ autostart: false, runners: [] });
    expect(loadConfig(memoryIo('{"autostart":"yes"}'))).toEqual({ autostart: false, runners: [] });
  });
});
