#!/usr/bin/env node
// SessionStart — hand the session the service it is about to change, before it changes it.
//
// The hook carries NO credential and makes no network call: it resolves the checkout to a workspace and a
// repository and then tells the session which Everdict reads to run. The MCP server the plugin bundles is
// what holds the credential, and it is the session's own tool call that presents it — so a hook that runs on
// a machine with no Everdict configured degrades to a sentence, never to a failed request.
//
// Resolution order, most explicit first. A workspace is never guessed: an unresolved repository is told so,
// because a default workspace would write one team's work into another's trust zone.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const stdin = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
  });
  process.stdin.on("end", () => resolve(buf));
});

const emit = (context) => {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }),
  );
  process.exit(0);
};

let input = {};
try {
  input = JSON.parse(stdin || "{}");
} catch {
  // A malformed payload is the harness's problem, not the session's — say nothing rather than crash it.
  process.exit(0);
}
const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd();

const git = (...args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

const root = git("rev-parse", "--show-toplevel");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
// NOT `origin` unconditionally: this repository's own remote is named `everdict`, and the first fixture run
// of this hook reported "no git remote" for the checkout it was written in. A repository with remotes has a
// name for them; assuming the conventional one is how a resolver reports absence for a present thing.
const firstRemote = git("remote")?.split("\n")[0]?.trim();
const originUrl =
  git("remote", "get-url", "origin") ?? (firstRemote ? git("remote", "get-url", firstRemote) : undefined);
const repository = originUrl ? (/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(originUrl)?.[1] ?? undefined) : undefined;

// A branch commonly carries the request it serves (`fix/DEFAUL-1-…`, `DIGO-7G-…`). It is a HINT, not an
// anchor: a pin's key for an issue is the record id, so the identifier has to be resolved before it can be
// asked with — which the session does, because the hook makes no calls of its own.
const issueHint = branch ? (/\b[A-Z][A-Z0-9]*-\d+\b/.exec(branch)?.[0] ?? undefined) : undefined;

const workspaceFile = root ? path.join(root, ".everdict", "workspace") : undefined;
const envWorkspace = process.env.EVERDICT_WORKSPACE?.trim();
const fileWorkspace =
  workspaceFile && existsSync(workspaceFile) ? readFileSync(workspaceFile, "utf8").trim() : undefined;
const workspace = envWorkspace || fileWorkspace || undefined;
const workspaceFrom = envWorkspace ? "EVERDICT_WORKSPACE" : fileWorkspace ? ".everdict/workspace" : undefined;

if (!workspace) {
  emit(
    [
      "# Everdict — not resolved for this checkout",
      "",
      `This repository (${repository ?? "no git remote"}) names no Everdict workspace, so nothing about this`,
      "session will be recorded and the Stop guard will not hold you to it.",
      "",
      "To put this repository's work on the record, ask the user which workspace it belongs to and write it:",
      "",
      "    mkdir -p .everdict && echo '<workspace-id>' > .everdict/workspace",
      "",
      "(or export EVERDICT_WORKSPACE=<workspace-id> for a one-off). `list_workspaces` shows what exists.",
    ].join("\n"),
  );
}

emit(
  [
    "# Everdict is this project's system of record",
    "",
    `- workspace: **${workspace}** (from ${workspaceFrom})`,
    `- repository: **${repository ?? "unknown"}**${branch ? ` · branch \`${branch}\`` : ""}`,
    "",
    "## Before you change code — run this, it is already addressed to this service",
    "",
    "```",
    `get_task_context ${JSON.stringify({ refs: [{ type: "repository", key: repository ?? "" }] })}`,
    "```",
    "",
    "That is the whole of Everdict's retrieval: it answers about the entities you NAME, and a task that names",
    "none gets nothing. The anchor above is the one this checkout can state for you — everything else you learn",
    "(the harness, the dataset, the campaign) is another anchor worth asking with.",
    ...(issueHint !== undefined
      ? [
          "",
          `The branch names **${issueHint}**. Resolve it with \`get_issue\` and anchor on the id it returns — a`,
          "pin's key is the record id, not the identifier, so the identifier alone matches nothing.",
        ]
      : ["", "`list_issues` — the work you are about to do probably belongs to an open request."]),
    "",
    "Each item comes back with its relation to the anchor (`covers` · `earlier` · `later` · `general`) and a",
    "coverage state. A `superseded` entry is returned too, ranked last: read it as history, never as the rule.",
    "",
    "## While you work",
    "",
    "The work belongs to an **issue**, and the change you make under it is a **campaign**",
    "(`/everdict:campaign` opens both). Everything the campaign produces — the code that ships and what the",
    "work taught — names that issue, so the request is one read away from its consequences.",
    "",
    "## File what you were given",
    "",
    "After that call, write what came back and what you then used — session-scoped, on the workspace",
    "filesystem, because the question it answers is *did this session get what it needed*:",
    "",
    "```",
    `write_file  path: knowledge/retrievals/${new Date().toISOString().slice(0, 10)}/<branch-or-topic>.json`,
    '  { "at", "anchors", "returned": [{id, title, relation, status}], "capped": bool,',
    '    "used": [id…], "outcome": "one line: what the work did with it" }',
    "```",
    "",
    "`used` is the part nobody else can know. An entry you actually built on also belongs in that entry's own",
    '`refs` as `{type:"knowledge", key}` — the file is the measurement, the pin is the lineage.',
    "",
    "## Before you stop",
    "",
    "Record what this session learned with `create_knowledge_entry` (`decision` · `finding` · `convention` ·",
    "`context`), `refs` naming the issue and the repository. `/everdict:record` does it for you.",
    "",
    "⚠️ A session that changed code and recorded nothing **is refused once at Stop**. The escape is deliberate:",
    "start Claude with `EVERDICT_BREAK_GLASS='<reason>'` and the reason is reported instead of the refusal.",
  ].join("\n"),
);
