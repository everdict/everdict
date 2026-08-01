#!/usr/bin/env node
// Artifact-frame design-system guard (docs/architecture/analysis-studio.md — "No agent-authored design").
//
// An `html` analysis artifact renders in an opaque-origin sandbox, which inherits NOTHING from the app — so
// the frame HANDS it the design system: apps/web forwards the live theme tokens and a class vocabulary, and
// @everdict/contracts names that same vocabulary in the emission tool's brief + the schema that enforces it.
// Three hand-maintained files therefore have to agree, and the web may not import the contract's list as a
// value (runtime decoupling), so nothing but this guard couples them.
//
// Drift here fails SILENTLY and in the worst possible way: the model is told to compose with a class that no
// longer exists, or paints with a token the theme never defines, and the dashboard quietly degrades into the
// off-theme output the whole mechanism exists to prevent. Nothing else in the tree can catch it — typecheck
// sees two unrelated string arrays, and tests on either side pass alone.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.relative(root, p);

const CONTRACT = path.join(root, "packages", "contracts", "src", "records", "analysis-artifact.ts");
const CARD = path.join(root, "apps", "web", "src", "entities", "analysis-artifact", "ui", "artifact-card.tsx");
const THEME = path.join(root, "apps", "web", "src", "app", "globals.css");

const contract = readFileSync(CONTRACT, "utf8");
const card = readFileSync(CARD, "utf8");
const theme = readFileSync(THEME, "utf8");

// Pull a `const NAME = [ … ] as const` / `= [ … ].join(…)` string array out of a source file.
function stringArray(source, name, where) {
  const start = source.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`${name} not found in ${where} — the guard needs it to compare the mirrors.`);
  const end = source.indexOf("\n]", start);
  return [...source.slice(start, end).matchAll(/["']((?:[^"'\\]|\\.)*)["']/g)].map((m) => m[1]);
}

// The custom properties a theme block declares, as name -> value.
function themeBlock(marker) {
  const start = theme.indexOf(marker);
  if (start < 0) throw new Error(`theme block ${marker} not found in ${rel(THEME)}`);
  const block = theme.slice(start, theme.indexOf("\n}", start));
  const values = {};
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) values[name] = value.trim();
  return values;
}

const violations = [];
const fail = (message) => violations.push(message);

const contractTokens = stringArray(contract, "ARTIFACT_FRAME_TOKENS", rel(CONTRACT));
const contractClasses = stringArray(contract, "ARTIFACT_FRAME_CLASSES", rel(CONTRACT));
const webTokens = stringArray(card, "FRAME_TOKENS", rel(CARD));
const stylesheet = stringArray(card, "FRAME_STYLESHEET", rel(CARD)).join("");

// 1. The mirror the web cannot import.
for (const token of contractTokens)
  if (!webTokens.includes(token))
    fail(`${rel(CARD)}: FRAME_TOKENS is missing ${token}, which the contract promises the frame publishes`);
for (const token of webTokens)
  if (!contractTokens.includes(token))
    fail(`${rel(CONTRACT)}: ARTIFACT_FRAME_TOKENS is missing ${token}, which the frame forwards but never names`);

// 2/3. `:root` defines every token and applies to BOTH themes; `.dark` only overrides what differs — so a
// token must exist in :root, and anything holding a COLOR must also be re-stepped for the dark surface (a
// light hue left on a near-black card is the exact theming bug the tokens exist to prevent).
const light = themeBlock("/* ── Light");
const dark = themeBlock("/* ── Dark");
const looksLikeColor = (value) => value !== undefined && /^(#|rgb|hsl|oklch|oklab|color-mix)/i.test(value);
for (const token of webTokens) {
  if (light[token] === undefined) {
    fail(`${rel(THEME)}: ${token} is forwarded into the artifact frame but never defined in :root`);
    continue;
  }
  if (looksLikeColor(light[token]) && dark[token] === undefined)
    fail(`${rel(THEME)}: ${token} is a color with no .dark value — it would render its light hue on the dark card`);
}

// 4. Every class the tool's brief tells the model to compose with must actually exist in the stylesheet.
for (const entry of contractClasses) {
  const [base, variants] = entry.split(" ");
  const names = variants ? [base, ...variants.split("|").map((v) => `${base}.${v}`)] : [base];
  for (const name of names)
    if (!stylesheet.includes(`.${name}`))
      fail(`${rel(CARD)}: FRAME_STYLESHEET defines no .${name}, but the agent's brief tells it to use that class`);
}

// 5. The frame's own stylesheet must be token-only. If IT hardcodes a color, the frame stops re-theming and
// becomes a second palette — while still refusing the agent the very thing it just did.
for (const [pattern, what] of [
  [/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z])/i, "a hex color"],
  [/\b(?:rgba?|hsla?|oklch|oklab)\s*\(/i, "a literal color function"],
  [/\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i, "a gradient"],
]) {
  const found = stylesheet.match(pattern);
  if (found) fail(`${rel(CARD)}: FRAME_STYLESHEET uses ${what} ("${found[0]}") — it must paint only with var(--token)`);
}

if (violations.length > 0) {
  console.error("artifact frame check FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(
  `PASS artifact frame: ${contractTokens.length} tokens mirrored + themed, ` +
    `${contractClasses.length} promised classes defined, stylesheet is token-only`,
);
