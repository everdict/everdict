import { AppError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { resolveFrontDoorFiles } from "../service-backend.js";
import { encodeBody } from "./front-door-driver.js";

describe("encodeBody (G2 — json vs multipart/form-data)", () => {
  it("defaults to application/json (no encoding, no files)", () => {
    const { body, contentType } = encodeBody({ prompt: "hi", n: 2 });
    expect(contentType).toBe("application/json");
    expect(JSON.parse(body.toString("utf8"))).toEqual({ prompt: "hi", n: 2 });
  });

  it("encodes multipart/form-data with text parts + file parts when encoding=form", () => {
    const { body, contentType } = encodeBody(
      { prompt: "search everdict", thread_id: "run-1" },
      { encoding: "form", files: [{ field: "file", filename: "input.csv", content: "a,b\n1,2" }] },
    );
    const m = contentType.match(/^multipart\/form-data; boundary=(.+)$/);
    expect(m).not.toBeNull();
    const text = body.toString("utf8");
    // text parts for each payload field
    expect(text).toContain('Content-Disposition: form-data; name="prompt"\r\n\r\nsearch everdict\r\n');
    expect(text).toContain('name="thread_id"\r\n\r\nrun-1\r\n');
    // the file part carries the filename + the raw content
    expect(text).toContain('name="file"; filename="input.csv"');
    expect(text).toContain("a,b\n1,2");
    // terminated by the closing boundary
    expect(text.trimEnd().endsWith("--")).toBe(true);
  });

  it("switches to multipart when files are present even without an explicit encoding", () => {
    const { contentType } = encodeBody({ prompt: "x" }, { files: [{ field: "f", filename: "a.txt", content: "x" }] });
    expect(contentType).toContain("multipart/form-data");
  });
});

describe("resolveFrontDoorFiles (G2 — attachment from the case env)", () => {
  const repoCase = (files: Record<string, string>) => ({
    id: "c1",
    env: { kind: "repo" as const, source: { files } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  });

  it("resolves each declared attachment from the case's inline repo files", () => {
    const parts = resolveFrontDoorFiles([{ field: "file", from: "input.csv" }], repoCase({ "input.csv": "a,b\n1,2" }));
    expect(parts).toEqual([{ field: "file", filename: "input.csv", content: "a,b\n1,2" }]);
  });

  it("honors an explicit filename override", () => {
    const parts = resolveFrontDoorFiles(
      [{ field: "f", from: "data", filename: "report.txt" }],
      repoCase({ data: "x" }),
    );
    expect(parts[0]?.filename).toBe("report.txt");
  });

  it("fails fast (config error) when a declared attachment is not in the case files", () => {
    try {
      resolveFrontDoorFiles([{ field: "file", from: "missing.csv" }], repoCase({ "other.csv": "x" }));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
      expect((err as Error).message).toMatch(/missing\.csv/);
    }
  });
});
