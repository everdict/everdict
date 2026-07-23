import type { BrowserProfileRecord, CaseJob } from "@everdict/contracts";
import type { SecretCipher } from "@everdict/db";
import { InMemoryBrowserProfileStore } from "@everdict/db";
import type { StorageState } from "@everdict/topology";
import { describe, expect, it } from "vitest";
import { makeProfileSeeder } from "./browser-profile-injector.js";

// Trivial reversible cipher (mirrors the capture-service test) — asserts decrypt without real crypto.
const fakeCipher: SecretCipher = {
  encrypt: (plaintext) => ({ ciphertext: `enc(${plaintext})`, iv: "iv", tag: "tag" }),
  decrypt: ({ ciphertext }) => ciphertext.replace(/^enc\((.*)\)$/, "$1"),
};

const STATE: StorageState = { cookies: [{ name: "sid", value: "secret", domain: ".github.com", path: "/" }] };

const job = (submittedBy?: string): CaseJob =>
  ({ tenant: "acme", ...(submittedBy ? { submittedBy } : {}) }) as unknown as CaseJob;

async function setup(withState: boolean) {
  const store = new InMemoryBrowserProfileStore();
  const record: BrowserProfileRecord = {
    id: "prof-1",
    tenant: "acme",
    name: "GitHub",
    visibility: "private",
    cookieDomains: [],
    country: null,
    capturedAt: null,
    expiresAt: null,
    createdBy: "alice",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
  await store.create(record);
  if (withState) {
    const blob = JSON.stringify(fakeCipher.encrypt(JSON.stringify(STATE)));
    await store.saveState("acme", "prof-1", blob, "2026-07-17T01:00:00.000Z", ["github.com"], null);
  }
  const seeded: Array<{ cdpBase: string; state: StorageState }> = [];
  const seed = makeProfileSeeder({
    store,
    cipher: fakeCipher,
    seed: async (cdpBase, state) => {
      seeded.push({ cdpBase, state });
    },
  });
  return { seed, seeded };
}

describe("makeProfileSeeder (browser-profiles S5)", () => {
  it("decrypts and seeds the owner's captured login into the eval browser", async () => {
    const { seed, seeded } = await setup(true);
    await seed("prof-1", "http://cdp.local", job("alice"));
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ cdpBase: "http://cdp.local", state: STATE });
  });

  it("skips injection when the run submitter does not own the profile (no cookie theft)", async () => {
    const { seed, seeded } = await setup(true);
    await seed("prof-1", "http://cdp.local", job("mallory"));
    expect(seeded).toHaveLength(0);
  });

  it("skips injection when the job has no submitter identity to gate on", async () => {
    const { seed, seeded } = await setup(true);
    await seed("prof-1", "http://cdp.local", job(undefined));
    expect(seeded).toHaveLength(0);
  });

  it("skips injection when the profile has no captured login yet (S3 not run)", async () => {
    const { seed, seeded } = await setup(false);
    await seed("prof-1", "http://cdp.local", job("alice"));
    expect(seeded).toHaveLength(0);
  });

  it("skips a profile that does not exist / belongs to another workspace", async () => {
    const { seed, seeded } = await setup(true);
    await seed("nope", "http://cdp.local", job("alice"));
    expect(seeded).toHaveLength(0);
  });
});
