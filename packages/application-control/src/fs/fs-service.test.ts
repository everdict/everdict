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
