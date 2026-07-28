import { BadRequestError, ConflictError, NotFoundError, normalizeFsPath } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { fsBucketFor } from "./fs-shared.js";
import { InMemoryWorkspaceFs } from "./in-memory-fs.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (d: Uint8Array) => new TextDecoder().decode(d);

describe("normalizeFsPath (the one isolation gate every operation funnels through)", () => {
  it("canonicalizes leading/repeated slashes, '.' segments and whitespace", () => {
    expect(normalizeFsPath("/a//b/./c ")).toBe("a/b/c");
    expect(normalizeFsPath("./reports/q3.md")).toBe("reports/q3.md");
    expect(normalizeFsPath("/")).toBe("");
    expect(normalizeFsPath("")).toBe("");
  });

  it("rejects traversal and unsafe characters — a path can never escape the workspace prefix", () => {
    expect(() => normalizeFsPath("../other-workspace/secret")).toThrow(BadRequestError);
    expect(() => normalizeFsPath("a/../../b")).toThrow(BadRequestError);
    expect(() => normalizeFsPath("a/b c")).toThrow(BadRequestError); // spaces are outside the safe set
    expect(() => normalizeFsPath("a\\b")).toThrow(BadRequestError);
  });
});

describe("fsBucketFor (one MinIO/S3 bucket per tenant — the isolation boundary)", () => {
  it("derives a deterministic, bucket-legal name per tenant", () => {
    const name = fsBucketFor("everdict-fs", "acme");
    expect(name).toBe(fsBucketFor("everdict-fs", "acme")); // deterministic
    expect(name.startsWith("everdict-fs-acme-")).toBe(true); // operator-readable
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/); // S3 bucket-name rules
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("never collides two DISTINCT tenants onto one bucket, even when sanitization would", () => {
    // case-only and charset-only differences sanitize to the same readable head — the hash tail keeps them apart
    expect(fsBucketFor("everdict-fs", "Acme")).not.toBe(fsBucketFor("everdict-fs", "acme"));
    expect(fsBucketFor("everdict-fs", "a.b")).not.toBe(fsBucketFor("everdict-fs", "a-b"));
    expect(fsBucketFor("everdict-fs", "a_b")).not.toBe(fsBucketFor("everdict-fs", "a.b"));
  });

  it("caps overlong tenants at the 63-char bucket limit and rejects an illegal prefix", () => {
    const long = fsBucketFor("everdict-fs", "w".repeat(200));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
    expect(() => fsBucketFor("Bad_Prefix", "acme")).toThrow(BadRequestError);
  });
});

describe("InMemoryWorkspaceFs (the WorkspaceFs contract semantics)", () => {
  it("isolates tenants: one workspace's tree is invisible to another", async () => {
    const fs = new InMemoryWorkspaceFs();
    await fs.write("acme", "reports/q3.md", utf8("# Q3"));
    expect(await fs.list("spica", "")).toEqual([]);
    expect(await fs.read("spica", "reports/q3.md")).toBeUndefined();
    expect((await fs.list("acme", "reports")).map((e) => e.path)).toEqual(["reports/q3.md"]);
  });

  it("round-trips a file write → read with a guessed content type", async () => {
    const fs = new InMemoryWorkspaceFs();
    const entry = await fs.write("acme", "/notes/hello.md", utf8("hi"));
    expect(entry).toMatchObject({ path: "notes/hello.md", name: "hello.md", kind: "file", size: 2 });
    expect(entry.contentType).toBe("text/markdown; charset=utf-8");
    const file = await fs.read("acme", "notes/hello.md");
    expect(file && text(file.data)).toBe("hi");
  });

  it("lists immediate children only — dirs first, name-sorted, deep files become implicit dirs", async () => {
    const fs = new InMemoryWorkspaceFs();
    await fs.write("acme", "b.txt", utf8("b"));
    await fs.write("acme", "a/deep/file.txt", utf8("x"));
    await fs.mkdir("acme", "z-empty");
    const root = await fs.list("acme", "");
    expect(root.map((e) => `${e.kind}:${e.path}`)).toEqual(["dir:a", "dir:z-empty", "file:b.txt"]);
    expect((await fs.list("acme", "a")).map((e) => `${e.kind}:${e.path}`)).toEqual(["dir:a/deep"]);
  });

  it("stat resolves files, explicit dirs, implicit dirs and the root; misses return undefined", async () => {
    const fs = new InMemoryWorkspaceFs();
    await fs.write("acme", "a/f.txt", utf8("x"));
    await fs.mkdir("acme", "made");
    expect((await fs.stat("acme", ""))?.kind).toBe("dir");
    expect((await fs.stat("acme", "a"))?.kind).toBe("dir"); // implicit via the file under it
    expect((await fs.stat("acme", "made"))?.kind).toBe("dir");
    expect((await fs.stat("acme", "a/f.txt"))?.kind).toBe("file");
    expect(await fs.stat("acme", "missing")).toBeUndefined();
  });

  it("keeps the file/dir axis consistent: no file over a dir, no children under a file", async () => {
    const fs = new InMemoryWorkspaceFs();
    await fs.write("acme", "dir/child.txt", utf8("x"));
    await expect(fs.write("acme", "dir", utf8("clobber"))).rejects.toBeInstanceOf(ConflictError);
    await fs.write("acme", "plain.txt", utf8("x"));
    await expect(fs.write("acme", "plain.txt/nested", utf8("y"))).rejects.toBeInstanceOf(ConflictError);
    await expect(fs.mkdir("acme", "plain.txt")).rejects.toBeInstanceOf(ConflictError);
    await expect(fs.read("acme", "dir")).rejects.toBeInstanceOf(BadRequestError); // a dir is not readable
  });

  it("removes: a file counts 1, a non-empty dir demands recursive, a miss counts 0", async () => {
    const fs = new InMemoryWorkspaceFs();
    await fs.write("acme", "d/one.txt", utf8("1"));
    await fs.write("acme", "d/sub/two.txt", utf8("2"));
    await expect(fs.remove("acme", "d")).rejects.toBeInstanceOf(ConflictError);
    expect(await fs.remove("acme", "d", { recursive: true })).toBe(2);
    expect(await fs.stat("acme", "d")).toBeUndefined();
    expect(await fs.remove("acme", "gone")).toBe(0);
    await fs.mkdir("acme", "empty");
    expect(await fs.remove("acme", "empty")).toBe(1); // an empty explicit dir removes without recursive
  });

  it("moves a file and a whole dir subtree; guards self-nesting, misses and occupied targets", async () => {
    const fs = new InMemoryWorkspaceFs();
    await fs.write("acme", "a/x.txt", utf8("x"));
    await fs.write("acme", "a/sub/y.txt", utf8("y"));
    const renamed = await fs.move("acme", "a/x.txt", "a/renamed.txt");
    expect(renamed.path).toBe("a/renamed.txt");
    await fs.move("acme", "a", "b");
    expect(await fs.stat("acme", "a")).toBeUndefined();
    expect((await fs.read("acme", "b/sub/y.txt"))?.entry.path).toBe("b/sub/y.txt");
    await expect(fs.move("acme", "b", "b/inside")).rejects.toBeInstanceOf(BadRequestError);
    await expect(fs.move("acme", "missing", "elsewhere")).rejects.toBeInstanceOf(NotFoundError);
    await fs.write("acme", "occupied.txt", utf8("z"));
    await expect(fs.move("acme", "b/renamed.txt", "occupied.txt")).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects oversized writes and any operation addressing the root as a file", async () => {
    const fs = new InMemoryWorkspaceFs();
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    await expect(fs.write("acme", "big.bin", big)).rejects.toBeInstanceOf(BadRequestError);
    await expect(fs.write("acme", "/", utf8("x"))).rejects.toBeInstanceOf(BadRequestError);
    await expect(fs.remove("acme", "")).rejects.toBeInstanceOf(BadRequestError);
  });
});
