import { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { installProxyDispatcher, proxyEnv, proxyRoutingDispatcher } from "./proxy-dispatcher.js";

describe("proxyEnv — the standard proxy env, read case-insensitively", () => {
  it("merges BOTH NO_PROXY spellings — compose fills no_proxy, the host shell exports NO_PROXY, and each may carry entries the other lacks (report 4.1)", () => {
    const p = proxyEnv({
      HTTP_PROXY: "http://proxy.corp:3128",
      NO_PROXY: ".corp.internal",
      no_proxy: "10.0.0.0/8,api",
    } as NodeJS.ProcessEnv);
    expect(p.noProxy).toBe(".corp.internal,10.0.0.0/8,api");
  });
  it("picks HTTP(S)_PROXY / NO_PROXY (upper preferred, lower fallback); trims and drops blanks", () => {
    expect(proxyEnv({ HTTPS_PROXY: "http://p:3128", NO_PROXY: "localhost,10.0.0.0/8" })).toEqual({
      httpsProxy: "http://p:3128",
      noProxy: "localhost,10.0.0.0/8",
    });
    expect(proxyEnv({ http_proxy: "http://lp:3128" })).toEqual({ httpProxy: "http://lp:3128" });
    expect(proxyEnv({ HTTP_PROXY: "  " })).toEqual({}); // a blank value is not a proxy
    expect(proxyEnv({})).toEqual({});
  });
});

describe("installProxyDispatcher — a proxy-aware global dispatcher only when a proxy is configured", () => {
  const orig = getGlobalDispatcher();
  afterEach(() => setGlobalDispatcher(orig)); // never leak a proxy dispatcher into other tests

  it("is a no-op (returns undefined, dispatcher untouched) when no proxy env is set", () => {
    const before = getGlobalDispatcher();
    expect(installProxyDispatcher({})).toBeUndefined();
    expect(getGlobalDispatcher()).toBe(before); // the default dispatcher is left in place (bare fetch, today)
  });

  it("installs a proxy-aware dispatcher and reports the config when a proxy is set", () => {
    const before = getGlobalDispatcher();
    const result = installProxyDispatcher({
      HTTPS_PROXY: "http://corp-proxy:3128",
      NO_PROXY: "localhost",
    });
    expect(result).toEqual({ httpsProxy: "http://corp-proxy:3128" }); // reported for the boot log (noProxy omitted)
    expect(getGlobalDispatcher()).not.toBe(before); // the global dispatcher — the SAME one Node's fetch reads — was replaced
  });
});

describe("proxyRoutingDispatcher — the operator's bypass list, applied where the request is routed", () => {
  const seen: string[] = [];
  const stub = (name: string): Dispatcher => {
    const d = new Dispatcher();
    d.dispatch = (options: Dispatcher.DispatchOptions): boolean => {
      seen.push(`${name}:${String(options.origin)}`);
      return true;
    };
    return d;
  };

  it("sends a CIDR-listed internal host DIRECT — undici's own matcher would have proxied it", async () => {
    seen.length = 0;
    const router = proxyRoutingDispatcher(stub("proxy"), "10.0.0.0/8,.internal", stub("direct"));
    const send = (origin: string): boolean => router.dispatch({ origin, path: "/", method: "POST" }, {});
    send("http://10.4.2.9:5000");
    send("https://mlflow.corp.internal");
    send("https://api.anthropic.com");
    // The two internal targets go direct; only the external one is handed to the proxy.
    expect(seen).toEqual([
      "direct:http://10.4.2.9:5000",
      "direct:https://mlflow.corp.internal",
      "proxy:https://api.anthropic.com",
    ]);
  });

  it("with no NO_PROXY there is no second pool — the proxy agent is used as-is", () => {
    const proxied = stub("proxy");
    expect(proxyRoutingDispatcher(proxied, undefined)).toBe(proxied);
  });
});
