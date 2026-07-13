import { CommandHarnessSpecSchema, type HarnessSpec, ServiceHarnessSpecSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { diffHarnessSpecs } from "./harness-diff.js";

const command = (over: Record<string, unknown>): HarnessSpec =>
  CommandHarnessSpecSchema.parse({
    kind: "command",
    id: "aider",
    version: "1.0.0",
    image: "ghcr.io/acme/aider@sha256:aaa",
    command: "aider {{task}}",
    env: { MODEL: "gpt-5.4-mini" },
    ...over,
  });

const service = (over: Record<string, unknown>): HarnessSpec =>
  ServiceHarnessSpecSchema.parse({
    kind: "service",
    id: "bu",
    version: "1.0.0",
    services: [
      { name: "backend", image: "ghcr.io/acme/api@sha256:aaa" },
      { name: "frontend", image: "ghcr.io/acme/web:1" },
    ],
    frontDoor: { service: "backend", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://otel" },
    ...over,
  });

describe("diffHarnessSpecs", () => {
  it("reports no changes for identical specs (only version differs)", () => {
    const diff = diffHarnessSpecs(command({ version: "1.0.0" }), command({ version: "1.1.0" }));
    expect(diff).toMatchObject({
      id: "aider",
      base: "1.0.0",
      candidate: "1.1.0",
      kindChanged: false,
      changes: [],
      summary: { added: 0, removed: 0, changed: 0 },
    });
  });

  it("reports command / image-pin / nested env changes as leaf paths", () => {
    const diff = diffHarnessSpecs(
      command({ version: "1.0.0" }),
      command({
        version: "1.1.0",
        image: "ghcr.io/acme/aider@sha256:bbb",
        command: "aider --fast {{task}}",
        env: { MODEL: "gpt-5.4" },
      }),
    );
    expect(diff.changes).toEqual([
      { path: "command", before: "aider {{task}}", after: "aider --fast {{task}}", change: "changed" },
      {
        path: "env.MODEL",
        before: "gpt-5.4-mini",
        after: "gpt-5.4",
        change: "changed",
      },
      {
        path: "image",
        before: "ghcr.io/acme/aider@sha256:aaa",
        after: "ghcr.io/acme/aider@sha256:bbb",
        change: "changed",
      },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 3 });
  });

  it("labels an env key present only in candidate as added", () => {
    const diff = diffHarnessSpecs(
      command({ env: { MODEL: "gpt-5.4-mini" } }),
      command({ version: "1.1.0", env: { MODEL: "gpt-5.4-mini", TEMPERATURE: "0.2" } }),
    );
    expect(diff.changes).toEqual([{ path: "env.TEMPERATURE", before: "(none)", after: "0.2", change: "added" }]);
    expect(diff.summary).toEqual({ added: 1, removed: 0, changed: 0 });
  });

  it("labels an env key present only in base as removed", () => {
    const diff = diffHarnessSpecs(
      command({ env: { MODEL: "gpt-5.4-mini", TEMPERATURE: "0.2" } }),
      command({ version: "1.1.0", env: { MODEL: "gpt-5.4-mini" } }),
    );
    expect(diff.changes).toEqual([{ path: "env.TEMPERATURE", before: "0.2", after: "(none)", change: "removed" }]);
    expect(diff.summary).toEqual({ added: 0, removed: 1, changed: 0 });
  });

  it("keys service arrays by name so a single service's image change surfaces at services[<name>].image", () => {
    const diff = diffHarnessSpecs(
      service({ version: "1.0.0" }),
      service({
        version: "1.1.0",
        services: [
          { name: "backend", image: "ghcr.io/acme/api@sha256:bbb" },
          { name: "frontend", image: "ghcr.io/acme/web:1" },
        ],
      }),
    );
    expect(diff.changes).toEqual([
      {
        path: "services[backend].image",
        before: "ghcr.io/acme/api@sha256:aaa",
        after: "ghcr.io/acme/api@sha256:bbb",
        change: "changed",
      },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  it("labels an added service (whole object leaf, keyed by name)", () => {
    const diff = diffHarnessSpecs(
      service({ version: "1.0.0" }),
      service({
        version: "1.1.0",
        services: [
          { name: "backend", image: "ghcr.io/acme/api@sha256:aaa" },
          { name: "frontend", image: "ghcr.io/acme/web:1" },
          { name: "worker", image: "ghcr.io/acme/worker:1" },
        ],
      }),
    );
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ path: "services[worker]", before: "(none)", change: "added" });
    expect(diff.summary).toEqual({ added: 1, removed: 0, changed: 0 });
  });

  it("flags kindChanged when the harness kind differs", () => {
    const diff = diffHarnessSpecs(command({ version: "1.0.0" }), service({ version: "2.0.0" }));
    expect(diff.kindChanged).toBe(true);
    expect(diff.changes.some((c) => c.path === "kind")).toBe(true);
  });
});
