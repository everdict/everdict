import { describe, expect, it } from "vitest";
import {
  CapabilityRecordSchema,
  CapabilitySpecSchema,
  CapabilityTypeSchema,
  EnvironmentImageSpecSchema,
} from "./capability.js";

// The environment kind — a managed eval-environment image as a store asset (image ref + preset dowry + instructions).
// The tool kinds (mcp|code|skill) are covered by the service/store/API suites; this file guards the fourth variant's
// schema shape. SSOT: docs/architecture/environment-image-store.md.
describe("EnvironmentImageSpecSchema", () => {
  it("parses a minimal environment (image + instructions)", () => {
    const spec = EnvironmentImageSpecSchema.parse({
      type: "environment",
      image: "ghcr.io/acme/officeqa-env@sha256:abc123",
      instructions: "# OfficeQA environment\nEntry point is /opt/officeqa/serve.py on :8000.",
    });
    expect(spec.type).toBe("environment");
    expect(spec.preset).toBeUndefined();
    expect(spec.contents).toBeUndefined();
  });

  it("parses a full preset — service fragment + dependencies + front door reuse the topology vocabulary", () => {
    const spec = EnvironmentImageSpecSchema.parse({
      type: "environment",
      image: "ghcr.io/acme/officeqa-env:v3",
      contents: { benchmark: "officeqa", packages: ["libreoffice", "python3.12"], os: "linux", arch: "amd64" },
      preset: {
        service: { port: 8000, env: { LOG_LEVEL: "info" }, needs: ["redis"] },
        dependencies: [{ store: "redis", role: "bus", isolateBy: "key-prefix" }],
        frontDoor: { service: "officeqa", submit: "POST /runs" },
      },
      instructions: "Wire REDIS_URL via the dependency inject.",
    });
    expect(spec.preset?.service?.port).toBe(8000);
    expect(spec.preset?.dependencies[0]?.store).toBe("redis");
  });

  it("rejects an image/name key on the preset service fragment (strict — the asset IS the image)", () => {
    const base = { type: "environment", image: "ghcr.io/acme/e:v1", instructions: "x" };
    expect(EnvironmentImageSpecSchema.safeParse({ ...base, preset: { service: { image: "other:v1" } } }).success).toBe(
      false,
    );
    expect(EnvironmentImageSpecSchema.safeParse({ ...base, preset: { service: { name: "svc" } } }).success).toBe(false);
  });

  it("rejects a preset dependency whose inject template uses a field outside the store vocabulary", () => {
    const result = EnvironmentImageSpecSchema.safeParse({
      type: "environment",
      image: "ghcr.io/acme/e:v1",
      instructions: "x",
      preset: {
        dependencies: [
          { store: "redis", role: "bus", isolateBy: "key-prefix", inject: [{ env: "X", template: "{bucket}" }] },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty image reference", () => {
    expect(EnvironmentImageSpecSchema.safeParse({ type: "environment", image: "", instructions: "x" }).success).toBe(
      false,
    );
  });
});

describe("CapabilitySpecSchema / CapabilityRecordSchema — the fourth variant", () => {
  it("discriminates environment beside the tool kinds and round-trips inside a record", () => {
    expect(CapabilityTypeSchema.options).toContain("environment");
    const record = CapabilityRecordSchema.parse({
      id: "officeqa-env",
      tenant: "acme",
      version: "1.0.0",
      name: "officeqa-env",
      description: "OfficeQA evaluation environment",
      spec: { type: "environment", image: "ghcr.io/acme/officeqa-env:v3", instructions: "…" },
      visibility: "subset",
      sharedWith: ["globex"],
      tags: ["benchmark"],
      createdBy: "user-1",
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    expect(record.spec.type).toBe("environment");
  });

  it("still rejects an unknown kind", () => {
    expect(CapabilitySpecSchema.safeParse({ type: "container", image: "x:1" }).success).toBe(false);
  });
});
