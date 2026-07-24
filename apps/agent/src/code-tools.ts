import type { ToolDefinition, ToolResult } from "@everdict/agent-runtime";
import type { ComputeHandle, ComputeSpec } from "@everdict/contracts";

// Code capabilities (type:'code') the conversational agent adopted from the Store, resolved to a runnable form. The
// pinned source runs inside a provisioned ComputeHandle — reusing the exact script-grader execution contract (input
// JSON as argv[1], a result on stdout) — and is bridged as a native callable tool. Adopted-from-others code is only
// ever run in an ISOLATED runtime; own-workspace code may run on a host driver in dev. See docs/architecture/capability-store.md.
export interface ResolvedCodeTool {
  name: string; // the tool name the agent sees (namespaced code__<name>)
  description: string;
  language: "python" | "node";
  code: string; // the pinned source (immutable version → auditable)
  parametersSchema: Record<string, unknown>; // JSON Schema for the tool's arguments (shown to the model verbatim)
  isReadOnly: boolean;
  env: Record<string, string>; // bound secret values (requiredSecrets → the adopter's own secrets → values)
  timeoutSec?: number;
  image?: string; // dedicated sandbox image (else the runtime's default)
  sandbox: boolean; // true when adopted from ANOTHER workspace (source !== tenant) → requires an isolated runtime
}

// How a code tool gets its compute. `isolated` = the provisioned handle is a real sandbox (e.g. DockerDriver), not the
// control-plane host (LocalDriver) — the gate that decides whether adopted-from-others code may run at all.
export interface CodeToolRuntime {
  provision: (spec: ComputeSpec) => Promise<ComputeHandle>;
  isolated: boolean;
}

// Fixed materialization paths — the script receives the input path as argv[1], so author code stays path-agnostic.
const INPUT_PATH = "/tmp/everdict-tool-input.json";
const SCRIPT_PATH: Record<ResolvedCodeTool["language"], string> = {
  python: "/tmp/everdict-tool.py",
  node: "/tmp/everdict-tool.mjs",
};
const INTERPRETER: Record<ResolvedCodeTool["language"], string> = { python: "python3", node: "node" };
const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

// The last JSON value on stdout is the result (logs before it are allowed) — same lenient rule as the script grader.
function lastJson(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  return /(\[[\s\S]*\]|\{[\s\S]*\})\s*$/.exec(stdout)?.[1];
}

// Interpret the script's stdout as a ToolResult. A `{content, isError?}` object is honored; any other JSON is passed
// through as the content string; plain text falls back to the trimmed stdout. The model just reads the content.
function toToolResult(stdout: string): ToolResult {
  const json = lastJson(stdout);
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed !== null && typeof parsed === "object" && "content" in parsed) {
        const obj = parsed as { content: unknown; isError?: unknown };
        if (typeof obj.content === "string") return { content: obj.content, isError: obj.isError === true };
      }
      return { content: json, isError: false };
    } catch {
      // fall through to raw stdout
    }
  }
  return { content: stdout.trim() || "(no output)", isError: false };
}

// Bridge one resolved code tool to a native ToolDefinition. Each call provisions a fresh handle, runs the script
// (input JSON in, result on stdout), and disposes the handle in a finally. Any execution failure becomes an
// error-marked ToolResult (never thrown) so the agent loop records it and can self-correct.
export function buildCodeTool(tool: ResolvedCodeTool, runtime: CodeToolRuntime): ToolDefinition {
  const parametersJsonSchema =
    Object.keys(tool.parametersSchema).length > 0 ? tool.parametersSchema : { type: "object", properties: {} };
  return {
    name: `code__${tool.name}`,
    description: tool.description,
    parametersJsonSchema,
    isReadOnly: tool.isReadOnly,
    call: async (input): Promise<ToolResult> => {
      let handle: ComputeHandle;
      try {
        handle = await runtime.provision({
          os: "linux",
          needs: ["shell"],
          ...(tool.image ? { image: tool.image } : {}),
        });
      } catch (err) {
        return {
          content: `code tool could not start: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      try {
        await handle.writeFile(INPUT_PATH, JSON.stringify(input ?? {}));
        const script = SCRIPT_PATH[tool.language];
        await handle.writeFile(script, tool.code);
        const cmd = `${INTERPRETER[tool.language]} ${shellQuote(script)} ${shellQuote(INPUT_PATH)}`;
        const r = await handle.exec(cmd, { timeoutSec: tool.timeoutSec ?? 120, env: tool.env });
        if (r.exitCode !== 0)
          return {
            content: `code tool exited ${r.exitCode}: ${`${r.stderr}${r.stdout}`.slice(0, 2000)}`,
            isError: true,
          };
        return toToolResult(r.stdout);
      } catch (err) {
        return { content: `code tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      } finally {
        await handle.dispose().catch(() => {});
      }
    },
  };
}

// Build the code-tool definitions the runtime can SAFELY run. Own-workspace code (sandbox:false) needs any runtime;
// adopted-from-others code (sandbox:true) needs an ISOLATED runtime — otherwise it is skipped (never run untrusted
// code on the host). Returns the definitions + the names skipped for lack of a safe runtime (so the caller can note them).
export function buildCodeTools(
  tools: ResolvedCodeTool[],
  runtime: CodeToolRuntime | undefined,
): { defs: ToolDefinition[]; skipped: string[] } {
  const defs: ToolDefinition[] = [];
  const skipped: string[] = [];
  for (const t of tools) {
    if (!runtime || (t.sandbox && !runtime.isolated)) {
      skipped.push(t.name);
      continue;
    }
    defs.push(buildCodeTool(t, runtime));
  }
  return { defs, skipped };
}
