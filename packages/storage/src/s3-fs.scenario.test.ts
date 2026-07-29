import { describe, expect, it } from "vitest";
import { S3WorkspaceFs } from "./s3-fs.js";

// Live E2E — drives the workspace filesystem against a real S3-compatible endpoint (MinIO in the self-hosted
// stack). Requires real infra, so skip when env is unset (CI-safe). Locally:
//   EVERDICT_E2E_S3_ENDPOINT=http://127.0.0.1:9102 \
//   EVERDICT_E2E_S3_ACCESS_KEY=everdict EVERDICT_E2E_S3_SECRET_KEY=… \
//   pnpm --filter @everdict/storage test s3-fs.scenario
//
// Regression guard for the batch-delete interop break: MinIO rejects the S3 DeleteObjects call the adapter
// used to make ("Missing required header for this request: Content-Md5" — aws-sdk-js v3 stopped sending it).
// Both cases below FAIL against MinIO on the pre-fix adapter, and the move case fails destructively: the copy
// lands, the source survives, and the tree is duplicated.
const ENDPOINT = process.env.EVERDICT_E2E_S3_ENDPOINT;
const ACCESS_KEY = process.env.EVERDICT_E2E_S3_ACCESS_KEY;
const SECRET_KEY = process.env.EVERDICT_E2E_S3_SECRET_KEY;

const utf8 = (s: string) => new TextEncoder().encode(s);

describe.skipIf(!ENDPOINT || !ACCESS_KEY || !SECRET_KEY)("S3WorkspaceFs — live S3/MinIO", () => {
  if (!ENDPOINT || !ACCESS_KEY || !SECRET_KEY) return; // type narrowing (separate from skipIf)
  const fs = new S3WorkspaceFs({
    endpoint: ENDPOINT,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    bucketPrefix: "everdict-e2e-fs",
  });
  const tenant = "scenario";

  it("removes a directory recursively — every key under it, not just the marker", async () => {
    await fs.write(tenant, "sweep/a.md", utf8("a"), "text/markdown");
    await fs.write(tenant, "sweep/nested/b.md", utf8("b"), "text/markdown");

    const removed = await fs.remove(tenant, "sweep", { recursive: true });

    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await fs.list(tenant, "sweep")).toEqual([]);
  });

  it("moves a directory ONCE — the subtree lands at the target and no copy is left behind", async () => {
    await fs.remove(tenant, "from", { recursive: true }).catch(() => 0);
    await fs.remove(tenant, "to", { recursive: true }).catch(() => 0);
    await fs.write(tenant, "from/report.md", utf8("body"), "text/markdown");

    const moved = await fs.move(tenant, "from", "to");

    expect(moved.path).toBe("to");
    expect((await fs.list(tenant, "to")).map((e) => e.path)).toEqual(["to/report.md"]);
    expect(await fs.list(tenant, "from")).toEqual([]); // the pre-fix adapter left the source in place
    await fs.remove(tenant, "to", { recursive: true });
  });
});
