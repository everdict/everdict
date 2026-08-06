import {
  FileExecutionService,
  FsService,
  RevisionedWorkspaceFs,
  RunService,
  SkillService,
} from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { ComputeHandle, Driver, ExecResult } from "@everdict/contracts";
import { InMemoryFsRevisionStore, InMemoryRunStore, InMemorySkillStore } from "@everdict/db";
import { InMemoryWorkspaceFs } from "@everdict/storage";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in fs tests");
  },
};

// A sandbox that always prints "done" and leaves one produced file behind — enough to prove the route wires the
// service through and that outputs land back on the filesystem. The real driver is docker (composition-gated).
const scriptedDriver: Driver = {
  id: "scripted",
  async provision(): Promise<ComputeHandle> {
    return {
      async exec(cmd: string): Promise<ExecResult> {
        if (cmd.startsWith("find")) return { exitCode: 0, stdout: "./chart.py\n./chart.png\n", stderr: "" };
        if (cmd.startsWith("wc -c")) return { exitCode: 0, stdout: "4\n", stderr: "" };
        if (cmd.startsWith("base64")) {
          return { exitCode: 0, stdout: Buffer.from("PNG!").toString("base64"), stderr: "" };
        }
        return { exitCode: 0, stdout: "done\n", stderr: "" };
      },
      async writeFile(): Promise<void> {},
      async readFile(): Promise<string> {
        throw new Error("unused");
      },
      async dispose(): Promise<void> {},
    };
  },
};

const H = { "x-everdict-tenant": "acme" };

// The composition the API actually runs: the filesystem WRAPPED in versioning, sharing one ledger with the
// service (main.ts wires exactly this), so these tests exercise publishing/conflict/history end to end.
function versionedFs(): FsService {
  const ledger = new InMemoryFsRevisionStore();
  return new FsService(new RevisionedWorkspaceFs(new InMemoryWorkspaceFs(), ledger), ledger);
}

function build(withFs = true) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  if (!withFs) return buildServer({ service });
  return buildServer({ service, fsService: versionedFs() });
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

  it("searches by content pattern and path glob (the recall primitive), workspace-scoped", async () => {
    const app = build();
    await app.inject({
      method: "PUT",
      url: "/fs/file",
      headers: H,
      payload: { path: "memory/cadence.md", content: "The team ships the eval report every Friday." },
    });
    await app.inject({
      method: "PUT",
      url: "/fs/file",
      headers: H,
      payload: { path: "reports/q3.md", content: "Q3 regression report." },
    });

    const grep = await app.inject({ method: "GET", url: "/fs/search?pattern=friday", headers: H });
    expect(grep.statusCode).toBe(200);
    expect(grep.json()).toMatchObject({
      matches: [{ path: "memory/cadence.md", line: 1 }],
      truncated: false,
    });

    const glob = await app.inject({ method: "GET", url: "/fs/search?glob=**/*.md", headers: H });
    expect((glob.json() as { matches: { path: string }[] }).matches.map((m) => m.path).sort()).toEqual([
      "memory/cadence.md",
      "reports/q3.md",
    ]);

    // Another workspace's search sees nothing (tenant isolation lives in the walk's own reads).
    const other = await app.inject({
      method: "GET",
      url: "/fs/search?pattern=friday",
      headers: { "x-everdict-tenant": "rival" },
    });
    expect(other.json()).toMatchObject({ matches: [] });

    // Neither pattern nor glob is a 400, as is an invalid regex.
    expect((await app.inject({ method: "GET", url: "/fs/search", headers: H })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/fs/search?pattern=(", headers: H })).statusCode).toBe(400);
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

    // Published history is real storage the tree walk cannot see, so it is reported on its own
    expect(body.history).toEqual({ revisions: 3, bytes: 7 });

    const cleared = await app.inject({ method: "DELETE", url: "/fs", headers: H }); // dev fallback = admin
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ removed: 3, purgedRevisions: 3 });
    const after = await app.inject({ method: "GET", url: "/fs/entries", headers: H });
    expect(after.json()).toEqual([]);
    // The wipe took the history with it — no orphaned revisions, no storage left behind
    const history = await app.inject({ method: "GET", url: "/fs/revisions?path=reports/q3.md", headers: H });
    expect(history.json()).toEqual([]);
    const old = await app.inject({ method: "GET", url: "/fs/revisions/content?path=top.txt&revision=1", headers: H });
    expect(old.statusCode).toBe(404);
  });

  it("keeps a deleted file's history so its content stays restorable", async () => {
    // Given a file that was published twice and then deleted
    const app = build();
    await app.inject({ method: "PUT", url: "/fs/file", headers: H, payload: { path: "notes.md", content: "v1" } });
    await app.inject({ method: "PUT", url: "/fs/file", headers: H, payload: { path: "notes.md", content: "v2" } });
    await app.inject({ method: "DELETE", url: "/fs/entry?path=notes.md", headers: H });
    // Then its history survives (unlike the whole-tree wipe) — "who deleted what" stays answerable…
    const history = await app.inject({ method: "GET", url: "/fs/revisions?path=notes.md", headers: H });
    expect(history.json()).toHaveLength(2);
    // …and restoring brings the content back as a new revision
    const restored = await app.inject({
      method: "POST",
      url: "/fs/revisions/restore",
      headers: H,
      payload: { path: "notes.md", revision: 1 },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().revision).toBe(3);
    const live = await app.inject({ method: "GET", url: "/fs/file?path=notes.md", headers: H });
    expect(live.json().content).toBe("v1");
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

  it("credits the member who saved a skill in SKILL.md's history, not 'the system'", async () => {
    // Given the skill service projecting onto the VERSIONED filesystem (the main.ts composition)
    const ledger = new InMemoryFsRevisionStore();
    const workspaceFs = new RevisionedWorkspaceFs(new InMemoryWorkspaceFs(), ledger);
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      fsService: new FsService(workspaceFs, ledger),
      skillService: new SkillService({ store: new InMemorySkillStore(), fs: workspaceFs }),
    });
    // When a member creates a skill and then edits it
    const created = await app.inject({
      method: "POST",
      url: "/skills",
      headers: H,
      payload: { name: "triage", description: "d", instructions: "v1" },
    });
    const id = created.json().id as string;
    await app.inject({ method: "PATCH", url: `/skills/${id}`, headers: H, payload: { instructions: "v2" } });
    // Then the file's history names them — the SKILL.md is editable from Settings, the shell and by agents, so
    // all three have to land in one comparable history instead of an anonymous system write.
    const history = await app.inject({
      method: "GET",
      url: `/fs/revisions?path=skills/${id}/SKILL.md`,
      headers: H,
    });
    expect(history.json()).toMatchObject([
      { revision: 2, actor: { kind: "member", subject: "dev" } },
      { revision: 1, actor: { kind: "member", subject: "dev" } },
    ]);
  });
});

describe("fs revisions (who published what, and safe concurrent editing)", () => {
  const write = (
    app: ReturnType<typeof build>,
    payload: Record<string, unknown>,
    headers: Record<string, string> = H,
  ) => app.inject({ method: "PUT", url: "/fs/file", headers, payload });

  it("publishes a numbered revision per write and reports the current one on read", async () => {
    const app = build();
    expect((await write(app, { path: "reports/q3.md", content: "draft" })).json().revision).toBe(1);
    expect((await write(app, { path: "reports/q3.md", content: "final" })).json().revision).toBe(2);
    const read = await app.inject({ method: "GET", url: "/fs/file?path=reports/q3.md", headers: H });
    expect(read.json().entry.revision).toBe(2);
  });

  it("records the author of every revision, and the AGENT when one wrote on a member's behalf", async () => {
    // Given a member's own edit followed by an agent's, declared through the attribution headers
    const app = build();
    await write(app, { path: "notes.md", content: "mine", message: "first" });
    const asAgent: Record<string, string> = {
      ...H,
      "x-everdict-agent-id": "analyst",
      "x-everdict-agent-name": "Analyst",
      "x-everdict-conversation-id": "sess-9",
    };
    await write(app, { path: "notes.md", content: "by the agent" }, asAgent);
    // Then the history distinguishes them — including which conversation the agent ran in
    const history = await app.inject({ method: "GET", url: "/fs/revisions?path=notes.md", headers: H });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject([
      { revision: 2, actor: { kind: "agent", agentId: "analyst", conversationId: "sess-9" } },
      { revision: 1, actor: { kind: "member" }, message: "first" },
    ]);
  });

  it("refuses a write built on a stale revision and hands back the merge kit", async () => {
    // Given two authors editing revision 1 of the same file
    const app = build();
    await write(app, { path: "notes.md", content: "line1\nline2\nline3\n" });
    await write(app, { path: "notes.md", content: "line1\nline2 by B\nline3\n", baseRevision: 1 });
    // When the slower author publishes against revision 1
    const stale = await write(app, { path: "notes.md", content: "line1 by A\nline2\nline3\n", baseRevision: 1 });
    // Then it is refused — with the live content and an auto-merge that keeps BOTH edits
    expect(stale.statusCode).toBe(409);
    const data = stale.json().data;
    expect(data).toMatchObject({ path: "notes.md", baseRevision: 1, headRevision: 2 });
    expect(data.head.content).toBe("line1\nline2 by B\nline3\n");
    expect(data.merge).toMatchObject({ merged: "line1 by A\nline2 by B\nline3\n", conflicts: [] });
    // And nothing was overwritten
    const read = await app.inject({ method: "GET", url: "/fs/file?path=notes.md", headers: H });
    expect(read.json().content).toBe("line1\nline2 by B\nline3\n");
  });

  it("reports a true conflict with both sides when the same line was rewritten", async () => {
    const app = build();
    await write(app, { path: "notes.md", content: "title\n" });
    await write(app, { path: "notes.md", content: "title by B\n", baseRevision: 1 });
    const stale = await write(app, { path: "notes.md", content: "title by A\n", baseRevision: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().data.merge.conflicts).toMatchObject([{ ours: "title by A", theirs: "title by B" }]);
  });

  it("accepts the retry once it declares the revision it actually merged", async () => {
    const app = build();
    await write(app, { path: "notes.md", content: "a\n" });
    await write(app, { path: "notes.md", content: "a\nb\n", baseRevision: 1 });
    const retry = await write(app, { path: "notes.md", content: "a\nb\nc\n", baseRevision: 2 });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().revision).toBe(3);
  });

  it("reads a past revision's content and restores it as a NEW attributed revision", async () => {
    // Given a file that was overwritten
    const app = build();
    await write(app, { path: "notes.md", content: "the good version" });
    await write(app, { path: "notes.md", content: "the bad version" });
    // Then the old content is still readable…
    const old = await app.inject({ method: "GET", url: "/fs/revisions/content?path=notes.md&revision=1", headers: H });
    expect(old.json()).toMatchObject({ content: "the good version", encoding: "utf8" });
    // …and restoring it publishes a THIRD revision rather than rewriting history
    const restored = await app.inject({
      method: "POST",
      url: "/fs/revisions/restore",
      headers: H,
      payload: { path: "notes.md", revision: 1 },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().revision).toBe(3);
    const live = await app.inject({ method: "GET", url: "/fs/file?path=notes.md", headers: H });
    expect(live.json().content).toBe("the good version");
    const history = await app.inject({ method: "GET", url: "/fs/revisions?path=notes.md", headers: H });
    expect(history.json()[0]).toMatchObject({ revision: 3, restoredFrom: 1 });
  });

  it("404s an unknown revision and never leaks another workspace's history", async () => {
    const app = build();
    await write(app, { path: "notes.md", content: "x" });
    const missing = await app.inject({
      method: "GET",
      url: "/fs/revisions/content?path=notes.md&revision=99",
      headers: H,
    });
    expect(missing.statusCode).toBe(404);
    const other = await app.inject({
      method: "GET",
      url: "/fs/revisions?path=notes.md",
      headers: { "x-everdict-tenant": "spica" },
    });
    expect(other.json()).toEqual([]);
  });

  it("diffs a past revision against the live file, and against another revision", async () => {
    // Given three revisions of a report
    const app = build();
    await write(app, { path: "notes.md", content: "intro\nbody\nend\n" });
    await write(app, { path: "notes.md", content: "intro\nbody rewritten\nend\n", baseRevision: 1 });
    await write(app, { path: "notes.md", content: "intro\nbody rewritten\nend\nappendix\n", baseRevision: 2 });
    // When comparing revision 1 to the live file
    const live = await app.inject({ method: "GET", url: "/fs/revisions/diff?path=notes.md&from=1", headers: H });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ path: "notes.md", from: 1, to: 3, diff: { added: 2, removed: 1 } });
    // …and when pinning both ends, only that step's change shows
    const step = await app.inject({ method: "GET", url: "/fs/revisions/diff?path=notes.md&from=2&to=3", headers: H });
    expect(step.json()).toMatchObject({ from: 2, to: 3, diff: { added: 1, removed: 0 } });
    const ops = step.json().diff.hunks.flatMap((h: { lines: { op: string; text: string }[] }) => h.lines);
    expect(ops).toContainEqual(expect.objectContaining({ op: "add", text: "appendix" }));
  });

  it("declines to invent a text diff for binary content", async () => {
    const app = build();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    await write(app, { path: "logo.png", content: bytes.toString("base64"), encoding: "base64" });
    await write(app, {
      path: "logo.png",
      content: Buffer.from([0x89, 0x50, 0x00]).toString("base64"),
      encoding: "base64",
    });
    const diff = await app.inject({ method: "GET", url: "/fs/revisions/diff?path=logo.png&from=1", headers: H });
    expect(diff.json().diff).toEqual({ hunks: [], added: 0, removed: 0, truncated: true });
  });

  it("pages back through a long history with the revision number as the cursor", async () => {
    // Given more revisions than one page shows
    const app = build();
    for (let i = 1; i <= 5; i++) await write(app, { path: "log.md", content: `v${i}` });
    // When taking the first page…
    const first = await app.inject({ method: "GET", url: "/fs/revisions?path=log.md&limit=2", headers: H });
    expect(first.json().map((r: { revision: number }) => r.revision)).toEqual([5, 4]);
    // …and continuing from its oldest row
    const next = await app.inject({ method: "GET", url: "/fs/revisions?path=log.md&limit=2&before=4", headers: H });
    expect(next.json().map((r: { revision: number }) => r.revision)).toEqual([3, 2]);
    const last = await app.inject({ method: "GET", url: "/fs/revisions?path=log.md&limit=2&before=2", headers: H });
    expect(last.json().map((r: { revision: number }) => r.revision)).toEqual([1]);
  });

  it("carries the history with the file when it is moved", async () => {
    const app = build();
    await write(app, { path: "draft.md", content: "v1" });
    await app.inject({ method: "POST", url: "/fs/move", headers: H, payload: { from: "draft.md", to: "final.md" } });
    const history = await app.inject({ method: "GET", url: "/fs/revisions?path=final.md", headers: H });
    expect(history.json()).toMatchObject([{ revision: 1 }]);
  });

  describe("POST /fs/executions", () => {
    it("is absent — not broken — when the deployment composed no execution driver", async () => {
      const app = build();

      const res = await app.inject({ method: "POST", url: "/fs/executions", headers: H, payload: { path: "a.py" } });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    });

    it("runs a file through the composed service and publishes what it produced", async () => {
      const ledger = new InMemoryFsRevisionStore();
      const fs = new RevisionedWorkspaceFs(new InMemoryWorkspaceFs(), ledger);
      const app = buildServer({
        service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
        fsService: new FsService(fs, ledger),
        fileExecutionService: new FileExecutionService(fs, { compute: scriptedDriver }),
      });
      await app.inject({
        method: "PUT",
        url: "/fs/file",
        headers: H,
        payload: { path: "reports/chart.py", content: "…" },
      });

      const res = await app.inject({
        method: "POST",
        url: "/fs/executions",
        headers: H,
        payload: { path: "reports/chart.py" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        exitCode: 0,
        stdout: "done\n",
        timedOut: false,
        outputs: [{ path: "reports/chart.png", size: 4 }],
      });
      const produced = await app.inject({ method: "GET", url: "/fs/file?path=reports/chart.png", headers: H });
      expect(produced.statusCode).toBe(200);
    });

    it("rejects a file it has no interpreter for", async () => {
      const ledger = new InMemoryFsRevisionStore();
      const fs = new RevisionedWorkspaceFs(new InMemoryWorkspaceFs(), ledger);
      const app = buildServer({
        service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
        fsService: new FsService(fs, ledger),
        fileExecutionService: new FileExecutionService(fs, { compute: scriptedDriver }),
      });
      await app.inject({ method: "PUT", url: "/fs/file", headers: H, payload: { path: "notes.md", content: "# hi" } });

      const res = await app.inject({
        method: "POST",
        url: "/fs/executions",
        headers: H,
        payload: { path: "notes.md" },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
