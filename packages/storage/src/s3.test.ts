import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { S3ArtifactStore } from "./s3.js";

const CREDENTIALS = { accessKeyId: "everdict", secretAccessKey: "secret" };
const OPTS = { endpoint: "http://minio:9000", bucket: "everdict-artifacts", ...CREDENTIALS };
const KEY = "analyses/sc1.json";

const signatureOf = (url: string): string | null => new URL(url).searchParams.get("X-Amz-Signature");

// A presigned GET URL signed by a client pointed straight at `endpoint` — the reference the store must reproduce.
const signAt = async (endpoint: string): Promise<string> =>
  getSignedUrl(
    new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: CREDENTIALS }),
    new GetObjectCommand({ Bucket: OPTS.bucket, Key: KEY }),
    { expiresIn: 3600 },
  );

describe("S3ArtifactStore — the presigned URL's host", () => {
  beforeEach(() => {
    // SigV4 stamps the clock into the signature, so pin it: the reference URLs below must sign identically.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never); // PutObject — no network in a unit test
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("put returns a SERVER-side handle — signed for the in-network endpoint even when a public base is configured", async () => {
    // Whoever re-reads a stored ref is our own code, inside the cluster (judge evidence, the analysis download).
    // Handing it the public address would route an in-cluster fetch out through a host the container may not reach.
    const store = new S3ArtifactStore({ ...OPTS, publicBaseUrl: "https://artifacts.example.com" });
    const url = await store.put(KEY, new Uint8Array([1]), "application/json");
    expect(new URL(url).host).toBe("minio:9000");
    expect(new URL(url).pathname).toBe(`/${OPTS.bucket}/${KEY}`);
  });

  it("publicUrlFor SIGNS for publicBaseUrl rather than swapping the host afterwards (a swap = 403 SignatureDoesNotMatch)", async () => {
    const store = new S3ArtifactStore({ ...OPTS, publicBaseUrl: "https://artifacts.example.com" });
    const stored = await store.put(KEY, new Uint8Array([1]), "application/json");
    const url = await store.publicUrlFor(stored);
    if (url === undefined) throw new Error("expected a re-minted url");

    expect(new URL(url).host).toBe("artifacts.example.com"); // the address the browser reaches
    expect(new URL(url).pathname).toBe(`/${OPTS.bucket}/${KEY}`);
    // Signed FOR that host: identical to signing at the public endpoint directly…
    expect(signatureOf(url)).toBe(signatureOf(await signAt("https://artifacts.example.com")));
    // …and NOT the old string rewrite of an internally-signed URL, which the store rejects (host is a signed header).
    expect(signatureOf(url)).not.toBe(signatureOf(await signAt(OPTS.endpoint)));
  });

  it("publicUrlFor re-signs an OLD ref (any host, expired) by its bucket-relative key, and declines a foreign one", async () => {
    const store = new S3ArtifactStore({ ...OPTS, publicBaseUrl: "https://artifacts.example.com" });
    // The shape already sitting in the database from before a public base existed.
    const old = `http://minio:9000/${OPTS.bucket}/scorecards/sc1/case%201.png?X-Amz-Signature=expired`;
    const fresh = await store.publicUrlFor(old);
    if (fresh === undefined) throw new Error("expected a re-minted url");
    expect(new URL(fresh).host).toBe("artifacts.example.com");
    expect(decodeURIComponent(new URL(fresh).pathname)).toBe(`/${OPTS.bucket}/scorecards/sc1/case 1.png`);
    expect(new URL(fresh).searchParams.get("X-Amz-Signature")).not.toBe("expired"); // re-signed, not patched

    expect(await store.publicUrlFor("http://minio:9000/someone-elses-bucket/x.png")).toBeUndefined();
    expect(await store.publicUrlFor("memory://artifacts/x.png")).toBeUndefined();
  });

  it("with no publicBaseUrl a re-mint stays on the internal endpoint (single-host deployment)", async () => {
    const store = new S3ArtifactStore(OPTS);
    const url = await store.publicUrlFor(`http://minio:9000/${OPTS.bucket}/${KEY}?X-Amz-Signature=old`);
    expect(url && new URL(url).host).toBe("minio:9000");
  });
});
