import { describe, expect, it } from "vitest";
import { BadRequestError } from "../errors.js";
import { assertPublicOutboundTarget, isPrivateAddress, refuseUnsafeOutboundUrl } from "./outbound-target.js";

// ── EVERY LANE THAT DIALS A CALLER-NAMED URL ASKS THE SAME QUESTION ──────────────────────────────────
//
// The control plane sits inside a network its callers do not, so any field where a caller or a producer
// names a destination and the platform dials it is SSRF. The repository had this decision — the literal
// scheme/host refusal and the resolve-then-judge check — living as two helpers inside the run-webhook
// consumer, exported from the package index and imported by nobody.
//
// Three other lanes dialled a caller-named URL with no check at all:
//
//   · `subscription.reaction.url`  — member-authored (`agents:write`), fired on EVERY matching event
//   · a pushed trace's artifact URLs — PRODUCER-authored, fetched into a judge's prompt
//   · `secret.tokenUrl`            — admin-authored, receives a refresh-token grant
//
// This is the decision itself. The per-lane tests assert that each lane calls it; this asserts what it
// decides, and that its two exceptions are opt-IN — a default that allowed either would make three lanes
// safe by accident and the fourth unsafe by omission, which is how this started.

describe("an outbound destination is judged before it is dialled", () => {
  it("refuses the metadata service however it is spelled", () => {
    expect(() => refuseUnsafeOutboundUrl("http://169.254.169.254/latest/meta-data/", "run webhook")).toThrow(
      BadRequestError,
    );
    expect(() => refuseUnsafeOutboundUrl("https://169.254.169.254/latest/meta-data/", "run webhook")).toThrow(
      /private address/,
    );
    expect(() => refuseUnsafeOutboundUrl("https://[::1]/hook", "run webhook")).toThrow(/private address/);
    expect(() => refuseUnsafeOutboundUrl("https://svc.internal/hook", "run webhook")).toThrow(/private address/);
    expect(() => refuseUnsafeOutboundUrl("https://10.0.0.5/hook", "run webhook")).toThrow(/private address/);
  });

  it("lets an ordinary public destination through, and names the lane when it does not", () => {
    expect(refuseUnsafeOutboundUrl("https://hooks.example.com/cb", "run webhook").hostname).toBe("hooks.example.com");
    try {
      refuseUnsafeOutboundUrl("https://localhost/x", "subscription webhook");
      expect.unreachable("a private host must be refused");
    } catch (err) {
      if (!(err instanceof BadRequestError)) throw err;
      // The operator has four lanes; a refusal that does not say which one leaves them grepping.
      expect(err.message).toContain("subscription webhook");
      expect(err.extra).toMatchObject({ lane: "subscription webhook" });
    }
  });

  // Both exceptions are OPT-IN. A default that allowed either would have made the safe lanes safe by
  // accident: this is the shape where "the caller passes false" is a convention and "the caller passes
  // nothing" is the secure answer.
  it("keeps both exceptions opt-in", () => {
    expect(() => refuseUnsafeOutboundUrl("http://hooks.example.com/cb", "run webhook")).toThrow(/is not https:/);
    expect(refuseUnsafeOutboundUrl("http://hooks.example.com/cb", "trace artifact", { allowHttp: true }).protocol).toBe(
      "http:",
    );
    // …and allowing http does NOT allow a private address: the two are separate decisions.
    expect(() => refuseUnsafeOutboundUrl("http://169.254.169.254/x", "trace artifact", { allowHttp: true })).toThrow(
      /private address/,
    );
    expect(
      refuseUnsafeOutboundUrl("https://localhost:8080/hook", "run webhook", { allowPrivateHosts: true }).hostname,
    ).toBe("localhost");
  });

  it("refuses a value that is not a URL at all rather than letting fetch decide", () => {
    expect(() => refuseUnsafeOutboundUrl("not a url", "run webhook")).toThrow(/is not a URL/);
  });

  // The literal check reads the NAME. A name is not a destination.
  it("judges where the name actually goes", async () => {
    const url = refuseUnsafeOutboundUrl("https://hook.attacker.example/cb", "run webhook"); // the literal check passes…
    await expect(assertPublicOutboundTarget(url, "run webhook", async () => ["169.254.169.254"])).rejects.toThrow(
      /resolves to the private address/,
    );
    await expect(assertPublicOutboundTarget(url, "run webhook", async () => [])).rejects.toThrow(/resolves to nothing/);
    // A name that resolves publicly keeps its own hostname — the URL is NOT rewritten to the address, because
    // TLS verifies the certificate against the host in the URL.
    expect((await assertPublicOutboundTarget(url, "run webhook", async () => ["93.184.216.34"])).hostname).toBe(
      "hook.attacker.example",
    );
  });

  it("classifies the address families it refuses", () => {
    for (const priv of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "172.16.0.1",
      "::1",
      "fd00::1",
      "box.local",
    ])
      expect(isPrivateAddress(priv), `${priv} must be refused`).toBe(true);
    for (const pub of ["example.com", "93.184.216.34", "8.8.8.8", "2001:4860:4860::8888"])
      expect(isPrivateAddress(pub), `${pub} must be allowed`).toBe(false);
  });
});
