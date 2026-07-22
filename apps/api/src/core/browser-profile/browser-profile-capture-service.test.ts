import { AppError, type BrowserProfileRecord } from "@everdict/contracts";
import type { SecretCipher } from "@everdict/db";
import { InMemoryBrowserProfileStore } from "@everdict/db";
import type { StorageState } from "@everdict/topology";
import { describe, expect, it } from "vitest";
import type { BrowserSessionProvisioner } from "../../common/browser-session-provisioner.js";
import { BrowserSessionService } from "../browser-session/browser-session-service.js";
import { BrowserProfileCaptureService } from "./browser-profile-capture-service.js";

// Trivial reversible cipher — asserts the service encrypts, without real crypto.
const fakeCipher: SecretCipher = {
  encrypt: (plaintext) => ({ ciphertext: `enc(${plaintext})`, iv: "iv", tag: "tag" }),
  decrypt: ({ ciphertext }) => ciphertext.replace(/^enc\((.*)\)$/, "$1"),
};

const fakeProvisioner: BrowserSessionProvisioner = {
  async provision() {
    return { cdpBase: "http://cdp.local", dispose: async () => undefined };
  },
};

const STATE: StorageState = {
  cookies: [
    { name: "sid", value: "secret", domain: ".github.com", path: "/" },
    { name: "csrf", value: "x", domain: "app.example.com", path: "/" },
  ],
};

function profileRecord(id: string, tenant: string, createdBy: string): BrowserProfileRecord {
  return {
    id,
    tenant,
    name: id,
    cookieDomains: [],
    country: null,
    capturedAt: null,
    createdBy,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

async function setup() {
  const store = new InMemoryBrowserProfileStore();
  await store.create(profileRecord("prof-1", "acme", "alice"));
  const sessions = new BrowserSessionService(fakeProvisioner, { newId: () => "sess-1" });
  const session = await sessions.create({ tenant: "acme", createdBy: "alice" });
  const capture = new BrowserProfileCaptureService({
    store,
    sessions,
    cipher: fakeCipher,
    capture: async () => STATE,
    now: () => "2026-07-16T12:00:00.000Z",
  });
  return { store, sessions, session, capture };
}

describe("BrowserProfileCaptureService", () => {
  it("captures the session cookies, encrypts them, and records capturedAt + derived domains", async () => {
    const { store, session, capture } = await setup();
    const updated = await capture.captureInto({
      tenant: "acme",
      profileId: "prof-1",
      sessionId: session.id,
      subject: "alice",
    });
    expect(updated.capturedAt).toBe("2026-07-16T12:00:00.000Z");
    // domains derived from the cookies (leading dot stripped, sorted)
    expect(updated.cookieDomains).toEqual(["app.example.com", "github.com"]);
    // the stored blob is the ENCRYPTED storageState envelope (server-only) — decrypting round-trips the cookies
    const stored = await store.loadState("acme", "prof-1");
    expect(stored).toBeDefined();
    const envelope = JSON.parse(stored ?? "{}");
    expect(envelope).toMatchObject({ ciphertext: expect.any(String), iv: "iv", tag: "tag" });
    expect(JSON.parse(fakeCipher.decrypt(envelope))).toEqual(STATE); // full storageState round-trips
  });

  it("saves only the selected cookies when a selection is given (per-cookie chips)", async () => {
    const { store, session, capture } = await setup();
    const updated = await capture.captureInto({
      tenant: "acme",
      profileId: "prof-1",
      sessionId: session.id,
      subject: "alice",
      // preview-normalized addressing: the stored domain is ".github.com" but the chip says "github.com"
      cookies: [{ domain: "github.com", name: "sid" }],
    });
    const stored = await store.loadState("acme", "prof-1");
    const state = JSON.parse(fakeCipher.decrypt(JSON.parse(stored ?? "{}")));
    expect(state.cookies).toEqual([{ name: "sid", value: "secret", domain: ".github.com", path: "/" }]);
    // derived domains reflect the FILTERED set, not everything the session held
    expect(updated.cookieDomains).toEqual(["github.com"]);
  });

  it("400s when the selection matches no cookie in the session anymore", async () => {
    const { session, capture } = await setup();
    await expect(
      capture.captureInto({
        tenant: "acme",
        profileId: "prof-1",
        sessionId: session.id,
        subject: "alice",
        cookies: [{ domain: "gone.example.com", name: "sid" }],
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("404s a profile owned by another subject (no existence leak)", async () => {
    const { session, capture } = await setup();
    await expect(
      capture.captureInto({ tenant: "acme", profileId: "prof-1", sessionId: session.id, subject: "mallory" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("400s when the session is not the caller's / not active", async () => {
    const { capture } = await setup();
    await expect(
      capture.captureInto({ tenant: "acme", profileId: "prof-1", sessionId: "nope", subject: "alice" }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
