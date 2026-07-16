import { describe, expect, it } from "vitest";
import { reachableWsUrl } from "./cdp-ws.js";

describe("reachableWsUrl", () => {
  it("rewrites the WS authority to the reachable CDP base (container internal :9222 → published host port)", () => {
    expect(reachableWsUrl("ws://127.0.0.1:9222/devtools/page/ABC", "http://127.0.0.1:54231")).toBe(
      "ws://127.0.0.1:54231/devtools/page/ABC",
    );
  });

  it("is a no-op when the authorities already match (host Chrome)", () => {
    expect(reachableWsUrl("ws://127.0.0.1:9222/devtools/page/X", "http://127.0.0.1:9222")).toBe(
      "ws://127.0.0.1:9222/devtools/page/X",
    );
  });

  it("preserves the path and scheme, only swapping host:port", () => {
    expect(reachableWsUrl("ws://browser-internal:9222/devtools/browser/abc", "http://10.0.0.5:8080")).toBe(
      "ws://10.0.0.5:8080/devtools/browser/abc",
    );
  });

  it("returns the original for an unparseable ws url", () => {
    expect(reachableWsUrl("not a url", "http://127.0.0.1:9222")).toBe("not a url");
  });
});
