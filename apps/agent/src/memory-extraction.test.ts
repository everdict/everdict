import type { ChatMessage } from "@everdict/agent-runtime";
import type { AgentMessageRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { maintainMemoryExtraction, turnWroteMemory } from "./memory-extraction.js";

const LONG_TURN: ChatMessage[] = [
  { role: "user", content: `Our staging cluster lives at nomad.internal:4646 — remember that. ${"x".repeat(400)}` },
  { role: "assistant", content: "Noted — I'll keep that in mind for future work." },
];

const SAVE_DECISION = JSON.stringify({
  save: true,
  slug: "staging-cluster-address",
  type: "reference",
  title: "Staging cluster address",
  description: "The staging Nomad cluster lives at nomad.internal:4646.",
  hook: "staging Nomad at nomad.internal:4646",
  body: "The staging Nomad cluster lives at nomad.internal:4646.",
});

// A workspace fs fake over McpInvoke: serves the index read and records every write with its arguments.
function fakeFs(opts: { index?: { content: string; revision: number }; bodyWriteFails?: boolean } = {}): {
  call: (name: string, args: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>;
  writes: Array<{ path: string; content: string; base_revision?: number }>;
} {
  const writes: Array<{ path: string; content: string; base_revision?: number }> = [];
  return {
    writes,
    call: async (name, args) => {
      if (name === "get_file") {
        if (!opts.index) return { content: "NOT_FOUND", isError: true };
        return {
          content: JSON.stringify({
            entry: { path: "memory/MEMORY.md", revision: opts.index.revision },
            content: opts.index.content,
            encoding: "utf8",
          }),
          isError: false,
        };
      }
      if (name === "write_file") {
        const path = String(args.path);
        if (opts.bodyWriteFails === true && path !== "memory/MEMORY.md") {
          return { content: "CONFLICT: already exists", isError: true };
        }
        writes.push({
          path,
          content: String(args.content),
          ...(typeof args.base_revision === "number" ? { base_revision: args.base_revision } : {}),
        });
        return { content: JSON.stringify({ path }), isError: false };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

describe("maintainMemoryExtraction — the turn-end safety net", () => {
  it("publishes ONE memory (expect-create) and appends the index line under the optimistic lock", async () => {
    // Given an existing index at revision 3 and an extractor that decides to save
    const fs = fakeFs({ index: { content: "# Workspace Memory\n\n- [Old](old.md) — old hook\n", revision: 3 } });
    // When the extraction runs
    const outcome = await maintainMemoryExtraction({
      call: fs.call,
      extract: async (index, transcript) => {
        expect(index).toContain("Old"); // the extractor sees what is already saved (dedup input)
        expect(transcript).toContain("nomad.internal:4646");
        return SAVE_DECISION;
      },
      turn: LONG_TURN,
    });
    // Then the body publishes as a create, with the memory file convention intact
    expect(outcome).toBe("saved");
    const body = fs.writes.find((w) => w.path === "memory/staging-cluster-address.md");
    expect(body?.base_revision).toBe(0); // "I expect to create this" — never an overwrite
    expect(body?.content).toContain("name: staging-cluster-address");
    expect(body?.content).toContain("type: reference");
    // …and the index gains exactly one line, written against the revision that was read
    const index = fs.writes.find((w) => w.path === "memory/MEMORY.md");
    expect(index?.base_revision).toBe(3);
    expect(index?.content).toContain("- [Old](old.md)");
    expect(index?.content).toContain("- [Staging cluster address](staging-cluster-address.md)");
  });

  it("creates the index (with its header) when the workspace has no memory yet", async () => {
    const fs = fakeFs();
    const outcome = await maintainMemoryExtraction({
      call: fs.call,
      extract: async () => SAVE_DECISION,
      turn: LONG_TURN,
    });
    expect(outcome).toBe("saved");
    const index = fs.writes.find((w) => w.path === "memory/MEMORY.md");
    expect(index?.content).toContain("# Workspace Memory");
    expect(index?.base_revision).toBe(0);
  });

  it("saves nothing when the extractor declines, replies malformed JSON, or shapes an invalid decision", async () => {
    for (const reply of [
      JSON.stringify({ save: false }),
      "not json at all",
      JSON.stringify({
        save: true,
        slug: "Bad Slug!",
        type: "reference",
        title: "t",
        description: "d",
        hook: "h",
        body: "b",
      }),
      JSON.stringify({
        save: true,
        slug: "ok-slug",
        type: "diary",
        title: "t",
        description: "d",
        hook: "h",
        body: "b",
      }),
    ]) {
      const fs = fakeFs();
      const outcome = await maintainMemoryExtraction({ call: fs.call, extract: async () => reply, turn: LONG_TURN });
      expect(outcome).toBe("skipped");
      expect(fs.writes).toHaveLength(0);
    }
  });

  it("a slug that already exists is a skip, and the index stays untouched", async () => {
    const fs = fakeFs({ index: { content: "# Workspace Memory\n", revision: 1 }, bodyWriteFails: true });
    const outcome = await maintainMemoryExtraction({
      call: fs.call,
      extract: async () => SAVE_DECISION,
      turn: LONG_TURN,
    });
    expect(outcome).toBe("skipped");
    expect(fs.writes.filter((w) => w.path === "memory/MEMORY.md")).toHaveLength(0);
  });

  it("a trivial turn never spends the model call", async () => {
    let extracted = 0;
    const fs = fakeFs();
    const outcome = await maintainMemoryExtraction({
      call: fs.call,
      extract: async () => {
        extracted += 1;
        return SAVE_DECISION;
      },
      turn: [{ role: "user", content: "thanks!" }],
    });
    expect(outcome).toBe("skipped");
    expect(extracted).toBe(0);
  });

  it("degrades every failure to an outcome — a dead fs never throws out of the turn boundary", async () => {
    const outcome = await maintainMemoryExtraction({
      call: async () => {
        throw new Error("fs unreachable");
      },
      extract: async () => SAVE_DECISION,
      turn: LONG_TURN,
    });
    expect(outcome).toBe("failed");
  });
});

describe("turnWroteMemory — the primary-writer stand-down gate", () => {
  const record = (name: string, args: Record<string, unknown>): AgentMessageRecord => ({
    id: "m-1",
    tenant: "acme",
    sessionId: "s-1",
    seq: 1,
    role: "assistant",
    content: "",
    toolCalls: [{ id: "t-1", name, arguments: JSON.stringify(args) }],
    createdAt: "2026-08-06T00:00:00.000Z",
  });

  it("stands down when the turn already wrote (or moved into, or deleted from) memory/", () => {
    expect(turnWroteMemory([record("write_file", { path: "memory/cadence.md" })])).toBe(true);
    expect(turnWroteMemory([record("move_file", { from: "notes/a.md", to: "memory/a.md" })])).toBe(true);
    expect(turnWroteMemory([record("delete_file", { path: "memory/old.md" })])).toBe(true);
  });

  it("runs for turns that only touched the rest of the tree (or nothing)", () => {
    expect(turnWroteMemory([record("write_file", { path: "reports/q3.md" })])).toBe(false);
    expect(turnWroteMemory([record("get_file", { path: "memory/cadence.md" })])).toBe(false);
    expect(turnWroteMemory([])).toBe(false);
  });
});
