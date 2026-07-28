import { FsService, RunService, SkillService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemorySkillStore } from "@everdict/db";
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

  it("usage reports totals + per-top-level breakdown, and clear empties the whole tree (admin governance)", async () => {
    const app = build();
    await app.inject({
      method: "PUT",
      url: "/fs/file",
      headers: H,
      payload: { path: "reports/q3.md", content: "1234" },
    });
    await app.inject({ method: "PUT", url: "/fs/file", headers: H, payload: { path: "data/rows.csv", content: "ab" } });
    await app.inject({ method: "PUT", url: "/fs/file", headers: H, payload: { path: "top.txt", content: "x" } });

    const usage = await app.inject({ method: "GET", url: "/fs/usage", headers: H });
    expect(usage.statusCode).toBe(200);
    const body = usage.json();
    expect(body).toMatchObject({ files: 3, bytes: 7, truncated: false });
    expect(body.topLevel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "reports", kind: "dir", files: 1, bytes: 4 }),
        expect.objectContaining({ path: "top.txt", kind: "file", files: 1, bytes: 1 }),
      ]),
    );

    const cleared = await app.inject({ method: "DELETE", url: "/fs", headers: H }); // dev fallback = admin
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().removed).toBe(3);
    const after = await app.inject({ method: "GET", url: "/fs/entries", headers: H });
    expect(after.json()).toEqual([]);
  });

  it("feature-gates: without fsService every /fs route is 404", async () => {
    const app = build(false);
    const res = await app.inject({ method: "GET", url: "/fs/entries", headers: H });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("not configured");
  });

  it("skill content lives ON the filesystem: saving a skill materializes skills/<id>/SKILL.md, and a shell edit wins", async () => {
    const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
    const workspaceFs = new InMemoryWorkspaceFs();
    const app = buildServer({
      service,
      fsService: new FsService(workspaceFs),
      skillService: new SkillService({ store: new InMemorySkillStore(), fs: workspaceFs }),
    });

    const created = await app.inject({
      method: "POST",
      url: "/skills",
      headers: H,
      payload: { name: "triage", description: "d", instructions: "# How to triage" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;

    const onFs = await app.inject({ method: "GET", url: `/fs/file?path=skills/${id}/SKILL.md`, headers: H });
    expect(onFs.statusCode).toBe(200);
    expect(onFs.json()).toMatchObject({ content: "# How to triage", encoding: "utf8" });

    // edit through the filesystem surface (the shell / agent write_file path) → the skill read reflects it
    await app.inject({
      method: "PUT",
      url: "/fs/file",
      headers: H,
      payload: { path: `skills/${id}/SKILL.md`, content: "# Edited via the shell" },
    });
    const skill = await app.inject({ method: "GET", url: `/skills/${id}`, headers: H });
    expect(skill.json().instructions).toBe("# Edited via the shell");
  });
});
