import { type HarnessTemplateSpec, HarnessTemplateSpecSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { summarizeInstanceVariation } from "./instance-variation.js";

const serviceTemplate: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
  kind: "service",
  category: "topology",
  id: "bu",
  version: "2",
  services: [
    { name: "planner", image: "ghcr.io/acme/planner:base", env: { LOG_LEVEL: "info" }, model: "gpt-4o" },
    { name: "browser", image: "chromedp/headless-shell:119" },
  ],
  dependencies: [],
  frontDoor: { service: "planner", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://o:4318" },
});

const commandTemplate: HarnessTemplateSpec = HarnessTemplateSpecSchema.parse({
  kind: "command",
  category: "cli-agent",
  id: "aider",
  version: "1",
  command: "aider --message {{task}} .",
  image: "ghcr.io/acme/aider:1",
  model: "gpt-4o",
});

describe("summarizeInstanceVariation", () => {
  it("says what a variation changed — model first, because that is the usual difference", () => {
    const chips = summarizeInstanceVariation(
      { pins: {}, overrides: { services: { planner: { model: "claude-opus-4-8" } } } },
      serviceTemplate,
    );
    expect(chips).toEqual([{ scope: "planner", label: "model=claude-opus-4-8" }]);
  });

  it("names an env key it dropped, so 'this one runs without it' is visible", () => {
    const chips = summarizeInstanceVariation(
      { pins: {}, overrides: { services: { planner: { unsetEnv: ["LOG_LEVEL"] } } } },
      serviceTemplate,
    );
    expect(chips).toEqual([{ scope: "planner", label: "−LOG_LEVEL" }]);
  });

  it("shows a secret-backed env by NAME — the spec holds no value to leak", () => {
    const chips = summarizeInstanceVariation(
      { pins: {}, overrides: { env: { OPENAI_API_KEY: { secretRef: "openai" } } } },
      commandTemplate,
    );
    expect(chips).toEqual([{ label: "OPENAI_API_KEY=🔒openai" }]);
  });

  it("a pin equal to the template's default is not a difference", () => {
    const chips = summarizeInstanceVariation({ pins: { planner: "ghcr.io/acme/planner:base" } }, serviceTemplate);
    expect(chips).toEqual([]);
  });

  it("a pin that differs is shown by its identifying tail, not the whole ref", () => {
    const chips = summarizeInstanceVariation({ pins: { planner: "ghcr.io/acme/planner:pr-9" } }, serviceTemplate);
    expect(chips).toEqual([{ scope: "planner", label: "planner:pr-9" }]);
  });

  it("a digest pin keeps the repository and a readable digest head (a 71-char ref would eat the row)", () => {
    const chips = summarizeInstanceVariation(
      { pins: { image: "ghcr.io/acme/aider@sha256:0123456789abcdef0123456789abcdef" } },
      commandTemplate,
    );
    expect(chips).toEqual([{ label: "image=aider@sha256:0123…" }]);
  });

  it("reports resources and the front-door body as behavioral differences", () => {
    const chips = summarizeInstanceVariation(
      {
        pins: {},
        overrides: {
          resources: { cpu: 4000, memoryMb: 8192 },
          frontDoor: { request: { bodyTemplate: { max_steps: 30 } } },
        },
      },
      commandTemplate,
    );
    expect(chips).toEqual([{ label: "cpu 4000 8192MB" }, { scope: "frontDoor", label: "max_steps=30" }]);
  });

  it("an instance with no delta has nothing to say (it IS the template)", () => {
    expect(summarizeInstanceVariation({ pins: {} }, serviceTemplate)).toEqual([]);
  });

  it("without a template every pin reads as a difference (nothing to compare against)", () => {
    const chips = summarizeInstanceVariation({ pins: { planner: "ghcr.io/acme/planner:base" } });
    expect(chips).toEqual([{ scope: "planner", label: "planner:base" }]);
  });
});
