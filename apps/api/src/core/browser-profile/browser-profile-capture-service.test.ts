import { AppError, type BrowserProfileRecord, ForbiddenError, NotFoundError } from "@everdict/contracts";
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

function profileRecord(
  id: string,
  tenant: string,
  createdBy: string,
  visibility: "private" | "workspace" = "private",
): BrowserProfileRecord {
  return {
    id,
    tenant,
    name: id,
    visibility,
    cookieDomains: [],
    country: null,
    capturedAt: null,
    expiresAt: null,
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
    resolveCdpBase: (id, subject) => sessions.cdpBaseFor(id, subject),
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
      isAdmin: false,
    });
    expect(updated.capturedAt).toBe("2026-07-16T12:00:00.000Z");
    // domains derived from the cookies (leading dot stripped, sorted)
    expect(updated.cookieDomains).toEqual(["app.example.com", "github.com"]);
    // STATE is session-only (no cookie carries an expiry) → no wall-clock expiry to surface
    expect(updated.expiresAt).toBeNull();
    // the stored blob is the ENCRYPTED storageState envelope (server-only) — decrypting round-trips the cookies
    const stored = await store.loadState("acme", "prof-1");
    expect(stored).toBeDefined();
    const envelope = JSON.parse(stored ?? "{}");
    expect(envelope).toMatchObject({ ciphertext: expect.any(String), iv: "iv", tag: "tag" });
    expect(JSON.parse(fakeCipher.decrypt(envelope))).toEqual(STATE); // full storageState round-trips
  });

  it("records the profile's expected expiry = the earliest cookie expiry (unix seconds → ISO)", async () => {
    const { store, sessions, session } = await setup();
    const capture = new BrowserProfileCaptureService({
      store,
      resolveCdpBase: (id, subject) => sessions.cdpBaseFor(id, subject),
      cipher: fakeCipher,
      // one session cookie (no expiry) + two persistent cookies — the earliest of the two is the profile's expiry
      capture: async () => ({
        cookies: [
          { name: "consent", value: "1", domain: ".github.com", path: "/", expires: 1_900_000_000 },
          { name: "sid", value: "secret", domain: ".github.com", path: "/", expires: 2_100_000_000 },
          { name: "ephemeral", value: "z", domain: ".github.com", path: "/" },
        ],
      }),
      now: () => "2026-07-16T12:00:00.000Z",
    });
    const updated = await capture.captureInto({
      tenant: "acme",
      profileId: "prof-1",
      sessionId: session.id,
      subject: "alice",
      isAdmin: false,
    });
    expect(updated.expiresAt).toBe(new Date(1_900_000_000 * 1000).toISOString());
  });

  it("saves only the selected cookies when a selection is given (per-cookie chips)", async () => {
    const { store, session, capture } = await setup();
    const updated = await capture.captureInto({
      tenant: "acme",
      profileId: "prof-1",
      sessionId: session.id,
      subject: "alice",
      isAdmin: false,
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
        isAdmin: false,
        cookies: [{ domain: "gone.example.com", name: "sid" }],
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("404s a member capturing into a PRIVATE profile they did not create (invisible — no admin override)", async () => {
    const { session, capture } = await setup(); // prof-1 is private, created by alice
    // A non-creator member — even an admin — cannot see a private profile: 404, no existence leak.
    await expect(
      capture.captureInto({
        tenant: "acme",
        profileId: "prof-1",
        sessionId: session.id,
        subject: "carol",
        isAdmin: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("403s a member capturing into a WORKSPACE profile they did not create (creator-or-admin)", async () => {
    const store = new InMemoryBrowserProfileStore();
    await store.create(profileRecord("prof-1", "acme", "alice", "workspace")); // shared, created by alice
    const sessions = new BrowserSessionService(fakeProvisioner, { newId: () => "sess-1" });
    const session = await sessions.create({ tenant: "acme", createdBy: "mallory" }); // mallory's own session
    const capture = new BrowserProfileCaptureService({
      store,
      resolveCdpBase: (id, subject) => sessions.cdpBaseFor(id, subject),
      cipher: fakeCipher,
      capture: async () => STATE,
    });
    await expect(
      capture.captureInto({
        tenant: "acme",
        profileId: "prof-1",
        sessionId: session.id,
        subject: "mallory",
        isAdmin: false,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets a workspace admin capture into another member's WORKSPACE profile, driving the admin's own session", async () => {
    const store = new InMemoryBrowserProfileStore();
    await store.create(profileRecord("prof-1", "acme", "bob", "workspace")); // shared, created by bob
    const sessions = new BrowserSessionService(fakeProvisioner, { newId: () => "sess-1" });
    await sessions.create({ tenant: "acme", createdBy: "admin" }); // the admin's own live session
    const capture = new BrowserProfileCaptureService({
      store,
      resolveCdpBase: (id, subject) => sessions.cdpBaseFor(id, subject),
      cipher: fakeCipher,
      capture: async () => STATE,
      now: () => "2026-07-16T12:00:00.000Z",
    });
    const updated = await capture.captureInto({
      tenant: "acme",
      profileId: "prof-1",
      sessionId: "sess-1",
      subject: "admin", // not the creator (bob) …
      isAdmin: true, // … but a workspace admin overrides the profile gate
    });
    expect(updated.capturedAt).toBe("2026-07-16T12:00:00.000Z");
  });

  it("restoreInto seeds the profile's saved cookies into the session (warm re-login)", async () => {
    const store = new InMemoryBrowserProfileStore();
    await store.create(profileRecord("prof-1", "acme", "alice"));
    // Pre-capture a login into the profile: an encrypted blob + carried domains.
    await store.saveState(
      "acme",
      "prof-1",
      JSON.stringify(fakeCipher.encrypt(JSON.stringify(STATE))),
      "2026-07-16T00:00:00.000Z",
      ["app.example.com", "github.com"],
      null,
    );
    const sessions = new BrowserSessionService(fakeProvisioner, { newId: () => "sess-1" });
    const session = await sessions.create({ tenant: "acme", createdBy: "alice" });
    const seeded: StorageState[] = [];
    const capture = new BrowserProfileCaptureService({
      store,
      resolveCdpBase: (id, subject) => sessions.cdpBaseFor(id, subject),
      cipher: fakeCipher,
      seed: async (_cdpBase, state) => {
        seeded.push(state);
      },
    });
    const result = await capture.restoreInto({
      tenant: "acme",
      profileId: "prof-1",
      sessionId: session.id,
      subject: "alice",
      isAdmin: false,
    });
    // the decrypted storageState was seeded into the session's browser, and the carried domains came back
    expect(seeded).toEqual([STATE]);
    expect(result.domains).toEqual(["app.example.com", "github.com"]);
  });

  it("restoreInto is a no-op for a profile with no login captured yet", async () => {
    const { session, capture } = await setup(); // prof-1 has no saveState
    const result = await capture.restoreInto({
      tenant: "acme",
      profileId: "prof-1",
      sessionId: session.id,
      subject: "alice",
      isAdmin: false,
    });
    expect(result.domains).toEqual([]); // nothing captured → nothing carried, and no seed attempted
  });

  it("restoreInto 403s a member restoring a WORKSPACE profile they did not create (creator-or-admin)", async () => {
    const store = new InMemoryBrowserProfileStore();
    await store.create(profileRecord("prof-1", "acme", "alice", "workspace")); // shared, created by alice
    const sessions = new BrowserSessionService(fakeProvisioner, { newId: () => "sess-1" });
    const session = await sessions.create({ tenant: "acme", createdBy: "mallory" }); // mallory's own session
    const capture = new BrowserProfileCaptureService({
      store,
      resolveCdpBase: (id, subject) => sessions.cdpBaseFor(id, subject),
      cipher: fakeCipher,
    });
    await expect(
      capture.restoreInto({
        tenant: "acme",
        profileId: "prof-1",
        sessionId: session.id,
        subject: "mallory",
        isAdmin: false,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("404s a profile in another workspace (no cross-tenant existence leak)", async () => {
    const { session, capture } = await setup();
    await expect(
      capture.captureInto({
        tenant: "beta",
        profileId: "prof-1",
        sessionId: session.id,
        subject: "alice",
        isAdmin: true, // even an admin can't reach a profile that isn't in their workspace
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("400s when the session is not the caller's / not active", async () => {
    const { capture } = await setup();
    await expect(
      capture.captureInto({
        tenant: "acme",
        profileId: "prof-1",
        sessionId: "nope",
        subject: "alice",
        isAdmin: false,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
