import type { FsEntry } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { FsFile, WorkspaceFs } from "../ports/workspace-fs.js";
import { FsService } from "./fs-service.js";

// A filesystem holding exactly one file, with whatever content type the test says was stored on it. Only `read`
// is exercised here; application-control cannot import @everdict/storage (reverse layer direction).
class StoredFile implements WorkspaceFs {
  constructor(
    private readonly path: string,
    private readonly data: Uint8Array,
    private readonly contentType: string | undefined,
  ) {}
  async read(_tenant: string, path: string): Promise<FsFile | undefined> {
    if (path !== this.path) return undefined;
    const entry: FsEntry = {
      path,
      name: path.split("/").at(-1) ?? path,
      kind: "file",
      size: this.data.byteLength,
      ...(this.contentType !== undefined ? { contentType: this.contentType } : {}),
    };
    return { entry, data: this.data };
  }
  async list(): Promise<FsEntry[]> {
    throw new Error("unused");
  }
  async stat(): Promise<FsEntry | undefined> {
    throw new Error("unused");
  }
  async write(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async mkdir(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async remove(): Promise<number> {
    throw new Error("unused");
  }
  async move(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async writeRevisionBlob(): Promise<void> {
    throw new Error("unused");
  }
  async readRevisionBlob(): Promise<FsFile | undefined> {
    throw new Error("unused");
  }
  async removeRevisionBlobs(): Promise<number> {
    return 0;
  }
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("FsService.readFile — resolving the content type of an already-stored file", () => {
  it("re-guesses the generic fallback, so a format the registry learned later applies retroactively", async () => {
    // Written when the registry had no row for `.go`: stored as the opaque fallback.
    const service = new FsService(new StoredFile("src/main.go", bytes("package main\n"), "application/octet-stream"));

    const file = await service.readFile("acme", "src/main.go");

    expect(file.encoding).toBe("utf8");
    expect(file.content).toBe("package main\n");
    expect(file.entry.contentType).toBe("text/x-go; charset=utf-8"); // the resolved type travels back to the caller
  });

  it("keeps a stored type that was an actual decision", async () => {
    const service = new FsService(new StoredFile("notes.md", bytes("# hi"), "text/plain; charset=utf-8"));

    const file = await service.readFile("acme", "notes.md");

    expect(file.entry.contentType).toBe("text/plain; charset=utf-8");
  });

  it("opens an unmapped extension holding valid utf-8 as text — the registry's last line of defence", async () => {
    const service = new FsService(new StoredFile("app.wjqx", bytes("host = localhost\nport = 8080\n"), undefined));

    const file = await service.readFile("acme", "app.wjqx");

    expect(file.encoding).toBe("utf8");
    expect(file.content).toContain("host = localhost");
    expect(file.entry.contentType).toBe("text/plain; charset=utf-8");
  });

  it("still reports a genuinely unknown extension as an opaque blob", async () => {
    const service = new FsService(new StoredFile("model.wjqx", new Uint8Array([0, 1, 2]), "application/octet-stream"));

    const file = await service.readFile("acme", "model.wjqx");

    expect(file.encoding).toBe("base64");
    expect(file.entry.contentType).toBe("application/octet-stream");
  });

  it("guesses when nothing was stored at all", async () => {
    const service = new FsService(new StoredFile("data/rows.csv", bytes("a,b\n1,2\n"), undefined));

    const file = await service.readFile("acme", "data/rows.csv");

    expect(file.encoding).toBe("utf8");
    expect(file.entry.contentType).toBe("text/csv; charset=utf-8");
  });
});

// A tiny in-package tree fake (application-control cannot import @everdict/storage): list/read over a path→bytes
// map, directories derived from path prefixes — enough surface for the search walk.
class TreeFs implements WorkspaceFs {
  constructor(private readonly files: Map<string, Uint8Array>) {}
  async list(_tenant: string, dir: string): Promise<FsEntry[]> {
    const prefix = dir === "" ? "" : `${dir}/`;
    const dirs = new Set<string>();
    const out: FsEntry[] = [];
    for (const [path, data] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        dirs.add(rest.slice(0, slash));
      } else {
        out.push({ path, name: rest, kind: "file", size: data.byteLength });
      }
    }
    return [
      ...[...dirs].sort().map((name): FsEntry => ({ path: `${prefix}${name}`, name, kind: "dir" })),
      ...out.sort((a, b) => a.name.localeCompare(b.name)),
    ];
  }
  async read(_tenant: string, path: string): Promise<FsFile | undefined> {
    const data = this.files.get(path);
    if (!data) return undefined;
    return { entry: { path, name: path.split("/").at(-1) ?? path, kind: "file", size: data.byteLength }, data };
  }
  async stat(): Promise<FsEntry | undefined> {
    throw new Error("unused");
  }
  async write(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async mkdir(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async remove(): Promise<number> {
    throw new Error("unused");
  }
  async move(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async writeRevisionBlob(): Promise<void> {
    throw new Error("unused");
  }
  async readRevisionBlob(): Promise<FsFile | undefined> {
    throw new Error("unused");
  }
  async removeRevisionBlobs(): Promise<number> {
    return 0;
  }
}

describe("FsService.search — the recall primitive", () => {
  const tree = (): TreeFs =>
    new TreeFs(
      new Map([
        ["memory/MEMORY.md", bytes("# Index\n- [Cadence](cadence.md) — Friday reports\n")],
        ["memory/cadence.md", bytes("---\ntype: feedback\n---\nThe team ships the eval report every Friday.\n")],
        ["reports/q3.md", bytes("Q3 regression report.\nFriday deep-dive attached.\n")],
        ["data/rows.csv", bytes("a,b\n1,2\n")],
        ["artifacts/blob.bin", new Uint8Array([0, 1, 2, 0])],
      ]),
    );

  it("greps file content across the tree with 1-based line numbers and excerpts", async () => {
    const result = await new FsService(tree()).search("acme", { pattern: "friday" });
    const paths = result.matches.map((m) => m.path).sort();
    expect(paths).toEqual(["memory/MEMORY.md", "memory/cadence.md", "reports/q3.md"]);
    const cadence = result.matches.find((m) => m.path === "memory/cadence.md");
    expect(cadence?.line).toBe(4);
    expect(cadence?.excerpt).toContain("every Friday");
    expect(result.truncated).toBe(false);
  });

  it("narrows by glob — * stays inside a segment, **/ crosses (and matches zero dirs)", async () => {
    const glob = await new FsService(tree()).search("acme", { glob: "memory/*.md" });
    expect(glob.matches.map((m) => m.path).sort()).toEqual(["memory/MEMORY.md", "memory/cadence.md"]);
    expect(glob.matches[0]?.line).toBeUndefined(); // glob-only matches carry no line
    const all = await new FsService(tree()).search("acme", { glob: "**/*.md" });
    expect(all.matches).toHaveLength(3);
    const scoped = await new FsService(tree()).search("acme", { glob: "**/*.md", pattern: "regression" });
    expect(scoped.matches.map((m) => m.path)).toEqual(["reports/q3.md"]);
  });

  it("scopes to a subtree via path", async () => {
    const result = await new FsService(tree()).search("acme", { path: "memory", pattern: "friday" });
    expect(result.matches.every((m) => m.path.startsWith("memory/"))).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("skips binary files, caps matches at the limit, and flags truncation", async () => {
    const binary = await new FsService(tree()).search("acme", { pattern: ".", glob: "artifacts/*" });
    expect(binary.matches).toHaveLength(0); // blob.bin is binary — grep skips it
    const capped = await new FsService(tree()).search("acme", { pattern: "\\w", limit: 2 });
    expect(capped.matches).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it("rejects a search with neither pattern nor glob, and an invalid regex", async () => {
    await expect(new FsService(tree()).search("acme", {})).rejects.toThrow(/pattern.*glob|glob.*pattern/);
    await expect(new FsService(tree()).search("acme", { pattern: "(" })).rejects.toThrow(/invalid search pattern/);
  });
});
