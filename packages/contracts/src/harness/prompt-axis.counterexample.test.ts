import { describe, expect, it } from "vitest";
import {
  type HarnessInstanceSpec,
  type HarnessTemplateSpec,
  instanceOverrideDefects,
  resolveHarnessInstance,
} from "./harness-template.js";

// ── THE PROMPT IS A COMPONENT, NOT AN ENV KEY THAT HAPPENS TO HOLD ONE ────────────────────────────
//
// A `command` harness's declared instance-variation channels were `env`, `unsetEnv`, `params` and `resources`.
// `params` substitutes RAW into the shell command (the flag channel — `{{task}}` beside it is `shq`-quoted), so
// a multi-line prompt cannot live there, and every campaign that evolved a prompt smuggled it through an env
// key the image's entrypoint happened to read. The SpreadsheetBench wave did exactly that
// (`overrides.env.CC_SCAFFOLD`), for nine rounds.
//
// It works, and it costs the platform the ability to SAY what moved: `diffHarnessSpecs` reports
// `env.CC_SCAFFOLD` — indistinguishable from a model name or a base URL — attribution has no prompt slot, and
// a delegate briefed to "change the prompt" has no named place to put it. Nothing declared that a harness HAS
// a prompt.
//
// So the template declares the DELIVERY (`promptChannel`) and the instance carries the TEXT
// (`overrides.prompt`); resolve folds them into the resolved spec's own `prompt` field AND the declared env
// key, from one source, so the digest seals it and the diff names it.
//
// Observed RED before the change:
//   TypeError: instanceOverrideDefects is not a function → (after the import was fixed)
//   AssertionError: expected [ "overrides 'prompt' cannot be applied…" ] to deeply equal []
//   AssertionError: expected undefined to be 'work step by step' // resolved.prompt
const template = (over: Partial<HarnessTemplateSpec> = {}): HarnessTemplateSpec =>
  ({
    kind: "command",
    id: "sbench",
    version: "1.0.0",
    image: "reg/sbench:1",
    setup: [],
    command: "claude -p {{task}}",
    env: { MODEL: "sonnet" },
    params: {},
    trace: { kind: "none" },
    promptChannel: { kind: "env", name: "CC_SCAFFOLD" },
    ...over,
  }) as HarnessTemplateSpec;

const instance = (over: Partial<HarnessInstanceSpec> = {}): HarnessInstanceSpec =>
  ({
    template: { id: "sbench", version: "1.0.0" },
    id: "sbench",
    version: "1.0.1",
    pins: {},
    ...over,
  }) as HarnessInstanceSpec;

describe("the prompt is a first-class axis of a command harness", () => {
  it("resolves onto the spec's own `prompt` field AND the channel the template declared", () => {
    const resolved = resolveHarnessInstance(template(), instance({ overrides: { prompt: "work step by step" } }));
    if (resolved.kind !== "command") throw new Error("expected a command spec");
    // Named, so the version diff can say "the prompt moved" instead of "an env key moved"…
    expect(resolved.prompt).toBe("work step by step");
    // …and delivered, so the image that reads the env key still receives it. One source, two renderings.
    expect(resolved.env.CC_SCAFFOLD).toBe("work step by step");
    expect(resolved.env.MODEL).toBe("sonnet");
  });

  it("is an applicable override for a command template, and only for one", () => {
    expect(instanceOverrideDefects("command", { prompt: "p" })).toEqual([]);
    expect(instanceOverrideDefects("service", { prompt: "p" }).join("\n")).toMatch(/'prompt'/);
    expect(instanceOverrideDefects("process", { prompt: "p" }).join("\n")).toMatch(/'prompt'/);
  });

  it("REFUSES a prompt the template declared no channel for — an override nothing reads is a version that did not vary", () => {
    const noChannel = template({ promptChannel: undefined } as Partial<HarnessTemplateSpec>);
    expect(() => resolveHarnessInstance(noChannel, instance({ overrides: { prompt: "p" } }))).toThrow(/promptChannel/);
  });

  it("refuses the ambiguity of writing the prompt twice — through the axis and through its own env key", () => {
    expect(() =>
      resolveHarnessInstance(template(), instance({ overrides: { prompt: "a", env: { CC_SCAFFOLD: "b" } } })),
    ).toThrow(/CC_SCAFFOLD/);
  });

  it("a template that ships a default prompt exposes it even with no override — the field is the effective value", () => {
    const withDefault = template({ env: { MODEL: "sonnet", CC_SCAFFOLD: "the default scaffold" } });
    const resolved = resolveHarnessInstance(withDefault, instance());
    if (resolved.kind !== "command") throw new Error("expected a command spec");
    expect(resolved.prompt).toBe("the default scaffold");
  });

  // ── THE ONE A SINGLE RESOLVE CANNOT SEE ──────────────────────────────────────────────────────────
  //
  // Every case above builds a fresh template literal and resolves it once, which is exactly why none of them
  // caught this: the first implementation wrote the channel key into the env object it was handed, and
  // `dropEnvKeys` returns its INPUT when there is nothing to drop — so with no env override that object IS
  // `template.env`, the one the registry holds. One instance's prompt then leaked into every later resolve of
  // that template, including a campaign's BASELINE, which equalizes the two sides and makes a real treatment
  // read as no change. `scripts/live/axis-matrix.mjs` found it against a live registry.
  //
  // Observed RED before the fix:
  //   AssertionError: expected { MODEL: 'sonnet', CC_SCAFFOLD: 'mine' } to deeply equal { MODEL: 'sonnet' }
  it("does not mutate the template — a second instance resolves as if the first had never existed", () => {
    const shared = template();
    const withPrompt = resolveHarnessInstance(shared, instance({ overrides: { prompt: "mine" } }));
    if (withPrompt.kind !== "command") throw new Error("expected a command spec");
    expect(withPrompt.env.CC_SCAFFOLD).toBe("mine");
    // The template the registry holds is untouched…
    expect(shared.kind === "command" ? shared.env : undefined).toEqual({ MODEL: "sonnet" });
    // …so a sibling instance that overrides nothing is the baseline, not the first instance's prompt.
    const sibling = resolveHarnessInstance(shared, instance({ version: "1.0.2" }));
    if (sibling.kind !== "command") throw new Error("expected a command spec");
    expect(sibling.prompt).toBeUndefined();
    expect(sibling.env).toEqual({ MODEL: "sonnet" });
  });

  it("a template with no channel and no prompt override is exactly what it was — nothing invented", () => {
    const plain = template({ promptChannel: undefined } as Partial<HarnessTemplateSpec>);
    const resolved = resolveHarnessInstance(plain, instance());
    if (resolved.kind !== "command") throw new Error("expected a command spec");
    expect(resolved.prompt).toBeUndefined();
    expect(resolved.env).toEqual({ MODEL: "sonnet" });
  });
});
