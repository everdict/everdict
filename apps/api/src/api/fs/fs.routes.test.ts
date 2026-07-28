import { FsService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { InMemoryWorkspaceFs } from "@everdict/storage";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in fs tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

function build(withFs = true) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  if (!withFs) return buildServer({ service });
  return buildServer({ service, fsService: new FsService(new InMemoryWorkspaceFs()) });
}

describe("fs routes (the workspace filesystem HTTP surface)", () => {
  it("write → list → read round-trips a text file, workspace-scoped", async () => {
    const app = build();
    const write = await app.inject({
      method: "PUT",
      url: "/fs/file",
      headers: H,
      payload: { path: "/reports/q3.md", content: "# Q3" },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toMatchObject({ path: "reports/q3.md", kind: "file", size: 4 });

    const list = await app.inject({ method: "GET", url: "/fs/entries?path=reports", headers: H });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ path: "reports/q3.md", kind: "file" }]);

    const read = await app.inject({ method: "GET", url: "/fs/file?path=reports/q3.md", headers: H });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ content: "# Q3", encoding: "utf8" });
  });

  it("isolates workspaces: another tenant sees an empty root and 404 on the file", async () => {
    const app = build();
    await app.inject({ method: "PUT", url: "/fs/file", headers: H, payload: { path: "a.txt", content: "x" } });
    const other = { "x-everdict-tenant": "spica" };
    const list = await app.inject({ method: "GET", url: "/fs/entries", headers: other });
    expect(list.json()).toEqual([]);
    const read = await app.inject({ method: "GET", url: "/fs/file?path=a.txt", headers: other });
    expect(read.statusCode).toBe(404);
  });

  it("round-trips binary via base64 (write encoding + read encoding)", async () => {
    const app = build();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const write = await app.inject({
      method: "PUT",
      url: "/fs/file",
      headers: H,
      payload: { path: "img/logo.png", content: bytes.toString("base64"), encoding: "base64" },
    });
    expect(write.statusCode).toBe(200);
    const read = await app.inject({ method: "GET", url: "/fs/file?path=img/logo.png", headers: H });
    expect(read.json()).toMatchObject({ encoding: "base64", content: bytes.toString("base64") });
  });

  it("mkdir → move → remove drive the full lifecycle with honest statuses", async () => {
    const app = build();
    const mkdir = await app.inject({
      method: "POST",
      url: "/fs/directories",
      headers: H,
      payload: { path: "work/drafts" },
    });
    expect(mkdir.statusCode).toBe(200);
    await app.inject({
      method: "PUT",
      url: "/fs/file",
      headers: H,
      payload: { path: "work/drafts/a.md", content: "a" },
    });

    const move = await app.inject({
      method: "POST",
      url: "/fs/move",
      headers: H,
      payload: { from: "work/drafts", to: "work/final" },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json()).toMatchObject({ path: "work/final", kind: "dir" });

    const conflict = await app.inject({ method: "DELETE", url: "/fs/entry?path=work/final", headers: H });
    expect(conflict.statusCode).toBe(409); // non-empty without recursive

    const removed = await app.inject({
      method: "DELETE",
      url: "/fs/entry?path=work/final&recursive=true",
      headers: H,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().removed).toBeGreaterThanOrEqual(1);

    const gone = await app.inject({ method: "DELETE", url: "/fs/entry?path=work/final", headers: H });
    expect(gone.statusCode).toBe(404);
  });

  it("rejects traversal with 400 — the path can never escape the workspace", async () => {
    const app = build();
    const read = await app.inject({ method: "GET", url: "/fs/file?path=../spica/secret.txt", headers: H });
    expect(read.statusCode).toBe(400);
    const write = await app.inject({
      method: "PUT",
      url: "/fs/file",
      headers: H,
      payload: { path: "../spica/x.txt", content: "x" },
    });
    expect(write.statusCode).toBe(400);
  });

  it("feature-gates: without fsService every /fs route is 404", async () => {
    const app = build(false);
    const res = await app.inject({ method: "GET", url: "/fs/entries", headers: H });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("not configured");
  });
});
