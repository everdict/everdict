import type { HarnessInstanceSpec, HarnessTemplateSpec } from "@everdict/contracts";

// What makes THIS harness different from the shape it rides on — read off the instance's own delta.
//
// Several harnesses on one template are told apart by their variation, not by their name alone, and a hand-written
// description answers that only until someone edits the pins and forgets the prose. The delta cannot drift: it IS
// what the resolver will apply. So the list, the picker and the detail all say "what is this one" from the same
// source the runtime uses.
//
// Pure display projection — never an input to resolution, and deliberately lossy (it is a chip row, not a diff).

export interface VariationChip {
  // Where the difference lives — a service name, "image"/"model" for a command, or the front door.
  scope?: string;
  label: string;
}

// How many chips a caller should render before folding the rest into "+N" — one number, so the list and the
// picker truncate identically instead of each inventing a cap.
export const VARIATION_CHIP_DISPLAY_LIMIT = 3;

// An image ref's identifying tail — a 71-char digest would push every other chip off the row.
function shortImage(ref: string): string {
  const at = ref.indexOf("@");
  if (at > 0) return `${repositoryTail(ref.slice(0, at))}@${ref.slice(at + 1, at + 12)}…`;
  const slash = ref.lastIndexOf("/");
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}
function repositoryTail(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash >= 0 ? repo.slice(slash + 1) : repo;
}

// An env value the chip can show. A secret reference shows the NAME, never a value (there is none in the spec).
function envLabel(key: string, value: unknown): string {
  if (typeof value === "string") return `${key}=${value}`;
  if (typeof value === "object" && value !== null && "secretRef" in value) {
    const ref = (value as { secretRef: unknown }).secretRef;
    return typeof ref === "string" ? `${key}=🔒${ref}` : key;
  }
  return key;
}

// The instance's delta → display chips, most identifying first (model → env → pins → resources → the rest).
// `template` is optional: with it, a pin equal to the template's default is not a difference and is dropped.
export function summarizeInstanceVariation(
  instance: Pick<HarnessInstanceSpec, "pins" | "overrides">,
  template?: HarnessTemplateSpec,
): VariationChip[] {
  const chips: VariationChip[] = [];
  const overrides = instance.overrides;

  // Per-service deltas — the model first (the most common variation), then env, then the box size.
  for (const [service, ov] of Object.entries(overrides?.services ?? {})) {
    if (typeof ov.model === "string") chips.push({ scope: service, label: `model=${ov.model}` });
    else if (ov.model) chips.push({ scope: service, label: "model" });
    for (const [key, value] of Object.entries(ov.env ?? {}))
      chips.push({ scope: service, label: envLabel(key, value) });
    for (const key of ov.unsetEnv ?? []) chips.push({ scope: service, label: `−${key}` });
    if (ov.resources) chips.push({ scope: service, label: resourceLabel(ov.resources) });
    if (ov.replicas !== undefined) chips.push({ scope: service, label: `×${ov.replicas}` });
  }

  // Command deltas.
  for (const [key, value] of Object.entries(overrides?.env ?? {})) chips.push({ label: envLabel(key, value) });
  for (const key of overrides?.unsetEnv ?? []) chips.push({ label: `−${key}` });
  for (const [key, value] of Object.entries(overrides?.params ?? {})) chips.push({ label: `${key}=${value}` });
  if (overrides?.resources) chips.push({ label: resourceLabel(overrides.resources) });

  // Pins — only where they differ from what the template already says (an unchanged pin is not a variation).
  for (const [slot, value] of Object.entries(instance.pins)) {
    if (defaultForSlot(template, slot) === value) continue;
    chips.push(
      slot === "image" || slot === "model"
        ? { label: `${slot}=${shortImage(value)}` }
        : { scope: slot, label: shortImage(value) },
    );
  }

  // Front-door body values — a step budget or a system prompt switch is a real behavioral difference.
  for (const [key, value] of Object.entries(overrides?.frontDoor?.request?.bodyTemplate ?? {})) {
    chips.push({ scope: "frontDoor", label: `${key}=${scalarLabel(value)}` });
  }
  return chips;
}

function resourceLabel(r: { cpu?: number; memoryMb?: number; gpu?: number }): string {
  const parts: string[] = [];
  if (r.cpu !== undefined) parts.push(`cpu ${r.cpu}`);
  if (r.memoryMb !== undefined) parts.push(`${r.memoryMb}MB`);
  if (r.gpu !== undefined) parts.push(`gpu ${r.gpu}`);
  return parts.join(" ");
}

// A body value the chip can show without turning into a JSON dump.
function scalarLabel(value: unknown): string {
  if (typeof value === "string") return value.length > 24 ? `${value.slice(0, 24)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? `[${value.length}]` : "{…}";
}

// The template's own default for a slot — a command's `image`/`model`, else the service whose slot this is.
function defaultForSlot(template: HarnessTemplateSpec | undefined, slot: string): string | undefined {
  if (!template) return undefined;
  if (template.kind === "command") {
    if (slot === "image") return template.image;
    if (slot === "model") return typeof template.model === "string" ? template.model : undefined;
    return undefined;
  }
  if (template.kind !== "service") return undefined;
  return template.services.find((s) => (s.slot ?? s.name) === slot)?.image;
}
