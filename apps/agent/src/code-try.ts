import type { CapabilityStore, SecretStore } from "@everdict/application-control";
import { BadRequestError, type CodeToolSpec, NotFoundError, UpstreamError } from "@everdict/contracts";
import { canConsumeCapability } from "@everdict/domain";
import { type CodeToolRuntime, type ResolvedCodeTool, buildCodeTools } from "./code-tools.js";
import type { Principal } from "./principal.js";

// Code-tool verification — the "don't adopt by reading source" loop (mirrors the skill test-drive):
//   check — syntax/compile validation only (node --check / py_compile). PARSES the source, never executes it, so it
//           is safe for any target; the store wizard runs it before publish.
//   run   — execute the tool against a concrete example input, exactly as the agent would (same execution contract,
//           same sandbox gate: code from ANOTHER workspace runs only on an isolated runtime, else it is refused).
// Targets: an unsaved draft spec (the wizard — the caller's own authorship) or a published capability ref (the
// store's try panel — resolved server-side with the visibility kernel re-checked; the client never sends trust).
// requiredSecrets resolve by their DECLARED name from the caller's workspace → personal secrets; unresolved names
// are reported so a failing run is explainable.

export interface CodeTryDeps {
  runtime: CodeToolRuntime;
  secretStore?: SecretStore; // absent (no KEK) → tools run secret-less; declared names all report missing
  capabilityStore?: CapabilityStore; // absent (no DB) → ref targets are unavailable
}

export type CodeTryTarget =
  | { kind: "spec"; name: string; spec: CodeToolSpec }
  | { kind: "ref"; source: string; id: string; version: string };

export interface CodeTryResult {
  mode: "check" | "run";
  ok: boolean; // check: source parses · run: the tool returned a non-error result
  content: string; // check: interpreter diagnostics (empty = clean) · run: the ToolResult content
  durationMs: number;
  missingSecrets: string[]; // declared secret names that did not resolve for the caller
}

const CHECK_TIMEOUT_SEC = 30;
const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
const SCRIPT_PATH: Record<CodeToolSpec["language"], string> = {
  python: "/tmp/everdict-tool-check.py",
  node: "/tmp/everdict-tool-check.mjs",
};
// Parse-only validation commands — neither executes the module's code.
const CHECK_COMMAND: Record<CodeToolSpec["language"], (script: string) => string> = {
  node: (script) => `node --check ${shellQuote(script)}`,
  python: (script) => `python3 -m py_compile ${shellQuote(script)}`,
};

// Resolve the target to a runnable tool. A ref is fetched + visibility-re-checked server-side; sandbox (=needs an
// isolated runtime) is derived from ownership, never taken from the client.
async function resolveTool(
  deps: CodeTryDeps,
  principal: Principal,
  target: CodeTryTarget,
): Promise<{ name: string; spec: CodeToolSpec; sandbox: boolean }> {
  if (target.kind === "spec") {
    return { name: target.name, spec: target.spec, sandbox: false }; // the caller's own draft — own-code semantics
  }
  if (!deps.capabilityStore) {
    throw new BadRequestError("BAD_REQUEST", {}, "Published-capability try is unavailable without a store.");
  }
  const record = await deps.capabilityStore.getVersion(target.source, target.id, target.version);
  if (!record || !canConsumeCapability(record, { tenant: principal.workspace, subject: principal.subject })) {
    // Not visible = nonexistent (no existence leak across reach tiers).
    throw new NotFoundError("NOT_FOUND", { id: target.id }, `capability '${target.id}' not found.`);
  }
  if (record.spec.type !== "code") {
    throw new BadRequestError("BAD_REQUEST", { id: target.id }, "Only code capabilities can be tried here.");
  }
  return { name: record.name, spec: record.spec, sandbox: target.source !== principal.workspace };
}

// Bind requiredSecrets by declared name from the caller's tiers (workspace first, then personal).
async function bindSecrets(
  deps: CodeTryDeps,
  principal: Principal,
  spec: CodeToolSpec,
): Promise<{ env: Record<string, string>; missing: string[] }> {
  if (spec.requiredSecrets.length === 0) return { env: {}, missing: [] };
  let scoped: Awaited<ReturnType<SecretStore["scopedEntries"]>> = { workspace: {}, user: {} };
  if (deps.secretStore) {
    try {
      scoped = await deps.secretStore.scopedEntries(principal.workspace, principal.subject);
    } catch {
      scoped = { workspace: {}, user: {} };
    }
  }
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const rs of spec.requiredSecrets) {
    const value = scoped.workspace[rs.name] ?? scoped.user[rs.name];
    if (value === undefined) missing.push(rs.name);
    else env[rs.name] = value;
  }
  return { env, missing };
}

// check — parse-only compile validation inside a fresh handle (the source is written, never run).
async function runCheck(deps: CodeTryDeps, spec: CodeToolSpec): Promise<{ ok: boolean; content: string }> {
  let handle: Awaited<ReturnType<CodeToolRuntime["provision"]>>;
  try {
    handle = await deps.runtime.provision({
      os: "linux",
      needs: ["shell"],
      ...(spec.image ? { image: spec.image } : {}),
    });
  } catch (err) {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      {},
      `check runtime could not start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const script = SCRIPT_PATH[spec.language];
    await handle.writeFile(script, spec.code);
    const r = await handle.exec(CHECK_COMMAND[spec.language](script), { timeoutSec: CHECK_TIMEOUT_SEC });
    const diagnostics = `${r.stderr}${r.stdout}`.trim();
    return { ok: r.exitCode === 0, content: diagnostics.slice(0, 4_000) };
  } finally {
    await handle.dispose().catch(() => {});
  }
}

export async function runCodeToolTry(
  deps: CodeTryDeps,
  principal: Principal,
  mode: "check" | "run",
  target: CodeTryTarget,
  input: Record<string, unknown> | undefined,
): Promise<CodeTryResult> {
  const { name, spec, sandbox } = await resolveTool(deps, principal, target);
  const started = Date.now();

  if (mode === "check") {
    const { ok, content } = await runCheck(deps, spec);
    return { mode, ok, content, durationMs: Date.now() - started, missingSecrets: [] };
  }

  const { env, missing } = await bindSecrets(deps, principal, spec);
  const tool: ResolvedCodeTool = {
    name,
    description: "",
    language: spec.language,
    code: spec.code,
    parametersSchema: spec.parametersSchema,
    isReadOnly: spec.isReadOnly,
    env,
    ...(spec.timeoutSec !== undefined ? { timeoutSec: spec.timeoutSec } : {}),
    ...(spec.image !== undefined ? { image: spec.image } : {}),
    sandbox,
  };
  // The SAME safety gate the agent applies: cross-workspace code refuses to run on a non-isolated runtime.
  const { defs } = buildCodeTools([tool], deps.runtime);
  const def = defs[0];
  if (!def) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { id: name },
      "This capability comes from another workspace, so trying it requires an isolated (sandboxed) runtime — the current runtime runs on the host.",
    );
  }
  const result = await def.call(input ?? {}, {});
  return {
    mode,
    ok: !result.isError,
    content: result.content,
    durationMs: Date.now() - started,
    missingSecrets: missing,
  };
}
