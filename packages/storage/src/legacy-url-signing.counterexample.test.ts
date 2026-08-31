import { describe, expect, it } from "vitest";
import { S3ArtifactStore } from "./s3.js";

// ── WHAT LOOKS LIKE OUR URL IS NOT A URL WE ISSUED ───────────────────────────────────────────────────
//
// `publicUrlFor` exists to RE-SIGN one of our refs so a browser gets a fresh, unexpired URL. It resolves the
// ref to a bucket key through `keyOf`, which accepted two shapes: the stable `artifact://<key>` handle, and —
// for rows written before the stable handle existed — any URL whose PATH begins with `/<bucket>/`. The host
// was deliberately not compared, so that an old ref naming the server-internal endpoint still resolved after
// a public base was configured.
//
// The deliberate part is right and the "any host" part is the defect: a `screenshotRef` is not always ours to
// begin with. `EnvSnapshot.screenshotRef` legitimately carries a producer's own http(s) artifact URL (the
// push-ingest channel; the judge resolver fetches those BARE, with no credentials, exactly because they are
// attacker-influenced). So a producer that knows the deployment's bucket name can submit
//
//     "screenshotRef": "https://attacker.invalid/<bucket>/<someone-elses-key>"
//
// and the run-detail read hands it to `publicUrlFor`, which signs that key WITH OUR CREDENTIALS and returns a
// working URL for an object the submitter has no relationship with. The bare fetch was designed for hostile
// input; the SIGNER never was.
//
//     the path starts with our bucket   ≠   we minted this URL
//
// The repair is an origin allowlist of the two addresses this store actually signs for — its endpoint and its
// publicBaseUrl — which is exactly what the original comment's legacy case needs and nothing more.

const OPTS = {
  endpoint: "http://minio.internal:9000",
  bucket: "everdict-artifacts",
  accessKeyId: "key",
  secretAccessKey: "secret",
  publicBaseUrl: "https://artifacts.example.com",
};

const store = (): S3ArtifactStore => new S3ArtifactStore(OPTS);

// The signed URL names the key it was minted for; reading it back is how we tell WHICH object was signed.
const signedKey = (url: string): string => new URL(url).pathname.replace(`/${OPTS.bucket}/`, "");

describe("publicUrlFor re-signs only refs this store issued", () => {
  it("re-signs the stable handle", async () => {
    const url = await store().publicUrlFor("artifact://runs/r1/screenshot.png");
    expect(url).toBeDefined();
    expect(signedKey(url ?? "")).toBe("runs/r1/screenshot.png");
    // Signed for the browser-facing address, not the internal one.
    expect(new URL(url ?? "").origin).toBe("https://artifacts.example.com");
  });

  // The legacy case the host comparison was omitted for: a presigned URL minted against the server-internal
  // endpoint, before `publicBaseUrl` was configured. It must keep resolving.
  it("re-signs a legacy presigned URL minted against our own endpoint", async () => {
    const legacy = `${OPTS.endpoint}/${OPTS.bucket}/runs/r2/dom.html?X-Amz-Signature=expired`;
    expect(signedKey((await store().publicUrlFor(legacy)) ?? "")).toBe("runs/r2/dom.html");
  });

  it("re-signs a legacy URL minted against the public base", async () => {
    const legacy = `${OPTS.publicBaseUrl}/${OPTS.bucket}/runs/r3/shot.png?X-Amz-Signature=expired`;
    expect(signedKey((await store().publicUrlFor(legacy)) ?? "")).toBe("runs/r3/shot.png");
  });

  // THE DEFECT. Same bucket name in the path, a host we never signed for.
  it("refuses a foreign host whose path merely starts with our bucket", async () => {
    const forged = `https://attacker.invalid/${OPTS.bucket}/tenants/rival/secret-run/evidence.png`;
    expect(await store().publicUrlFor(forged)).toBeUndefined();
  });

  it("refuses a foreign host on a store with no public base configured", async () => {
    const bare = new S3ArtifactStore({ ...OPTS, publicBaseUrl: undefined });
    expect(await bare.publicUrlFor(`https://attacker.invalid/${OPTS.bucket}/k`)).toBeUndefined();
    // …while its own endpoint still resolves.
    expect(signedKey((await bare.publicUrlFor(`${OPTS.endpoint}/${OPTS.bucket}/k`)) ?? "")).toBe("k");
  });

  // A port or scheme difference is a different origin: `https://minio.internal:9000` is not the endpoint we
  // sign for, and neither is the same host on another port. Origin equality, not hostname equality.
  it("compares the whole origin, not just the hostname", async () => {
    const s = store();
    expect(await s.publicUrlFor(`https://minio.internal:9000/${OPTS.bucket}/k`)).toBeUndefined();
    expect(await s.publicUrlFor(`http://minio.internal:9001/${OPTS.bucket}/k`)).toBeUndefined();
    expect(await s.publicUrlFor(`http://artifacts.example.com/${OPTS.bucket}/k`)).toBeUndefined();
  });

  // Unchanged, and pinned so the origin check cannot be mistaken for the whole guard: another bucket on OUR
  // OWN host is still not ours to sign.
  it("refuses another bucket even on our own origin", async () => {
    expect(await store().publicUrlFor(`${OPTS.endpoint}/other-bucket/k`)).toBeUndefined();
  });

  // A producer's own report that names nothing of ours — a path inside the compute, a dev memory ref. It is
  // not a URL, so there is nothing to re-sign and nothing to refuse.
  it("ignores a non-URL ref", async () => {
    const s = store();
    expect(await s.publicUrlFor("/tmp/shot.png")).toBeUndefined();
    expect(await s.publicUrlFor("memory://k")).toBeUndefined();
  });
});
