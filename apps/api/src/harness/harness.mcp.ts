import { HarnessInstanceSpecSchema } from "@everdict/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setVersionTags } from "../lib/version-tag-service.js";
import { type McpToolContext, fail, ok, plain, run } from "../mcp-context.js";
import { repinHarnessImages } from "./harness-pin-service.js";
import { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "./harness-service.js";

// Harness-instance MCP tools — the MCP twin of harness.routes.ts.
export function registerHarnessTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  // Individual harness (instance: template reference + pins). No gate (viewer+).
  if (deps.harnessInstances) {
    const instances = deps.harnessInstances;
    server.registerTool(
      "list_harnesses",
      { description: "Harness instances this workspace sees (grouped by template; owned + _shared)", inputSchema: {} },
      () =>
        run(principal, "harnesses:read", async () => {
          // A private harness (references a personal secret) is createdBy-only — hidden from other users (same as the HTTP list).
          const entries = await instances.list(ws);
          return ok(entries.filter((e) => !e.private || (e.latestCreatedBy ?? e.createdBy) === principal.subject));
        }),
    );

    server.registerTool(
      "get_harness_instance",
      {
        description:
          "Fetch one harness instance raw spec (template reference + pins) — for config view / new-version re-pin prefill",
        inputSchema: { id: z.string(), version: z.string().describe('instance version tag or "latest"') },
      },
      ({ id, version }) =>
        run(principal, "harnesses:read", async () => ok(await instances.getInstance(ws, id, version))),
    );

    server.registerTool(
      "delete_harness",
      {
        description:
          "Soft-delete a harness version (tombstone — past scorecard history is preserved, future runs fail to resolve). Only that version's creator or a workspace admin.",
        inputSchema: {
          id: z.string(),
          version: z.string().describe("instance version to delete (exact version — latest not allowed)"),
        },
      },
      ({ id, version }) => plain(async () => ok(await deleteHarnessVersion(instances, principal, id, version))),
    );

    server.registerTool(
      "set_harness_version_tags",
      {
        description:
          "Replace a harness version's full tag set (empty array = remove all) — free labels for when a version number alone is hard to tell apart (e.g. baseline, gpt-5 experiment). Off-spec mutable metadata, so independent of version immutability and editable after registration. Same gate as registration (harnesses:register). _shared / other-workspace versions are NOT_FOUND.",
        inputSchema: {
          id: z.string(),
          version: z.string().describe("exact instance version (latest not allowed)"),
          tags: z
            .array(z.string())
            .describe("this version's full tag set (each ≤60 chars, ≤20 per version; replace semantics)"),
        },
      },
      ({ id, version, tags }) =>
        plain(async () => {
          // A private harness (references a personal secret) is createdBy-only — its existence is hidden from others (same as the HTTP route).
          if (!(await harnessVisibleTo(instances, principal, id))) return fail("NOT_FOUND: harness not found.");
          return ok(await setVersionTags(instances, principal, "harnesses:register", id, version, tags));
        }),
    );

    server.registerTool(
      "register_harness",
      {
        description:
          "Register a harness instance (template reference + pins, JSON string) (immutable; error if the template is missing / pins are absent). No gate (viewer+). Optional description = this version's changelog (shown on the detail page)",
        inputSchema: {
          spec: z
            .string()
            .describe(
              "HarnessInstanceSpec JSON: { template:{id,version}, id, version, pins, description? } (description = this version's changelog, optional)",
            ),
        },
      },
      ({ spec }) =>
        run(principal, "harnesses:register", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(spec);
          } catch {
            return fail("BAD_REQUEST: not a valid HarnessInstanceSpec JSON.");
          }
          const result = HarnessInstanceSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          // creator stamp = HTTP parity — without it a user-secret (private) instance becomes invisible even to its registrant
          await instances.register(ws, result.data, principal.subject); // resolve validation (missing template / absent pins → error)
          // Visibility tradeoff surfaced at write time (HTTP parity): user-scope secretRef → visible to you only.
          const isPrivate = await harnessIsPrivate(instances, ws, result.data.id, result.data.version);
          return ok({
            workspace: ws,
            id: result.data.id,
            version: result.data.version,
            ...(isPrivate ? { private: true } : {}),
          });
        }),
    );

    server.registerTool(
      "pin_harness_images",
      {
        description:
          "Durable re-pin of a harness instance (headless re-pin) — merge into the base version's pins and register a new version. The path where CI (dev/main merge) swaps only its own service slots. Enforces digest pins (default), idempotent (identical pins → unchanged)",
        inputSchema: {
          id: z.string(),
          pins: z.record(z.string()).describe("slot → image ref (@sha256:… digest recommended)"),
          version: z.string().optional().describe('explicit version (e.g. "dev-<sha>"). Auto-bump if unspecified'),
          base: z.string().optional().describe("base instance version (default latest)"),
          allow_tags: z
            .boolean()
            .optional()
            .describe("lift the digest requirement (default false — tag pins break reproducibility)"),
        },
      },
      ({ id, pins, version, base, allow_tags }) =>
        run(principal, "harnesses:register", async () =>
          ok(
            await repinHarnessImages(instances, ws, principal.subject, id, {
              pins,
              ...(version !== undefined ? { version } : {}),
              ...(base !== undefined ? { base } : {}),
              allowTags: allow_tags ?? false,
            }),
          ),
        ),
    );
  }
}
