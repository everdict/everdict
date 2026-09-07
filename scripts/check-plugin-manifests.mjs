#!/usr/bin/env node
// Plugin-manifest guard (docs/guide/integrations/codex.md — "Driving Everdict from Codex").
//
// This repo is a plugin marketplace for TWO clients, and they disagree about one thing: Claude Code expands
// `${VAR}` inside a plugin's `.mcp.json` at launch, Codex does not. A bundled `"url": "${EVERDICT_MCP_URL}"`
// therefore reaches Codex as that literal string and every session dies at
// `invalid MCP server URL ${EVERDICT_MCP_URL}: relative URL without a base` — which the user experiences as
// the plugin failing its handshake, with nothing in the manifest looking wrong.
//
// Codex resolves a plugin's `.mcp.json` BY CONVENTION, so the only way off it is a Codex manifest that points
// `mcpServers` at a file of its own. That indirection is invisible — delete `.codex-plugin/` and both
// manifests still parse, both clients still install, and only Codex breaks, at runtime, on the user's machine.
// Nothing else in the tree can catch it: these are data files no compiler or test reads.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
// watches: nothing — reads two manifest files.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.relative(root, p);
const violations = [];
const fail = (message) => violations.push(message);

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`${rel(file)}: not readable as JSON (${err.message})`);
    return undefined;
  }
};

// A `.mcp.json` is either `{ mcpServers: { name: server } }` or the bare `{ name: server }` map — both clients
// accept both shapes, so normalize before inspecting.
const serversOf = (doc) => {
  const map = doc && typeof doc === "object" && "mcpServers" in doc ? doc.mcpServers : doc;
  return map && typeof map === "object" ? Object.entries(map) : [];
};

const UNEXPANDED = /\$\{[^}]+\}/;
const placeholderServers = (file) => {
  if (!existsSync(file)) return [];
  const doc = readJson(file);
  return serversOf(doc)
    .filter(([, server]) => UNEXPANDED.test(JSON.stringify(server ?? null)))
    .map(([name]) => name);
};

const MARKETPLACE = path.join(root, ".claude-plugin", "marketplace.json");
const marketplace = readJson(MARKETPLACE);
const entries = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
if (entries.length === 0) fail(`${rel(MARKETPLACE)}: declares no plugins — the guard has nothing to check`);

for (const entry of entries) {
  // `source` is relative to the MARKETPLACE ROOT (the repo), not to the `.claude-plugin/` directory it sits in.
  const pluginRoot = path.resolve(root, entry.source ?? ".");
  if (!existsSync(pluginRoot)) {
    fail(`${rel(MARKETPLACE)}: plugin "${entry.name}" points at ${rel(pluginRoot)}, which does not exist`);
    continue;
  }

  // Claude Code: the manifest is what makes the directory a plugin at all.
  const claudeManifest = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(claudeManifest)) fail(`${rel(pluginRoot)}: missing ${rel(claudeManifest)} (Claude Code manifest)`);

  // Codex: only the bundled `.mcp.json` can hand it an unexpandable URL, so only that file forces a manifest.
  const bundled = path.join(pluginRoot, ".mcp.json");
  const withPlaceholders = placeholderServers(bundled);
  if (withPlaceholders.length === 0) continue;

  const codexManifest = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  if (!existsSync(codexManifest)) {
    fail(
      `${rel(bundled)}: server(s) ${withPlaceholders.join(", ")} use \${…}, which Codex does not expand — ` +
        `add ${rel(codexManifest)} pointing mcpServers away from this file`,
    );
    continue;
  }

  const codex = readJson(codexManifest);
  if (typeof codex?.mcpServers !== "string") {
    fail(
      `${rel(codexManifest)}: must set "mcpServers" to a file path — without it Codex falls back to ` +
        `${rel(bundled)} by convention and inherits the unexpanded \${…} url`,
    );
    continue;
  }

  const codexServers = path.resolve(pluginRoot, codex.mcpServers);
  if (!existsSync(codexServers)) {
    fail(`${rel(codexManifest)}: "mcpServers" points at ${rel(codexServers)}, which does not exist`);
    continue;
  }
  if (path.resolve(codexServers) === path.resolve(bundled)) {
    fail(`${rel(codexManifest)}: "mcpServers" points back at ${rel(bundled)}, the file with the \${…} url`);
    continue;
  }
  const leaked = placeholderServers(codexServers);
  if (leaked.length > 0) fail(`${rel(codexServers)}: server(s) ${leaked.join(", ")} still use \${…}`);
}

if (violations.length > 0) {
  console.error("plugin manifest check FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`PASS plugin manifests: ${entries.length} plugin(s), no client is handed an unexpanded \${…} url`);
