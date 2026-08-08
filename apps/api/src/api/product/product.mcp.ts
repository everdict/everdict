import {
  PRODUCT_SERIES_LIMIT,
  ProductAutoEvalSchema,
  ProductSeriesSchema,
  ReleaseStatusSchema,
} from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";
import { ProductServiceBodySchema } from "./request/create-product.js";

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// MCP twin of the product routes (BFF↔MCP parity). The tools an agent reaches for when asked "how is the
// product doing since we shipped" — the timeline's axis: tracked services, imported versions, watch series,
// gated releases.
export function registerProductTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.productService) return;
  const products = deps.productService;
  const actor = { subject: principal.subject };

  server.registerTool(
    "create_product",
    {
      description:
        "Create a product on the timeline — the released thing several services compose. `services` name the " +
        "GitHub repositories whose releases/tags mark 'this component moved' (source: releases | tags, with an " +
        "optional tagPrefix for monorepos); `series` declare the dataset × harness × judges trends the product " +
        "is judged by (each series' key is its durable trend identity). Auto-eval is on by default: a genuinely " +
        "new imported version submits one scorecard per watched series.",
      inputSchema: {
        name: z.string().min(1).max(200),
        description: z.string().max(10_000).optional(),
        icon: z.string().max(8).optional().describe("one emoji — how the product is recognized in a list"),
        services: z.array(ProductServiceBodySchema).max(50).optional(),
        series: z.array(ProductSeriesSchema).max(PRODUCT_SERIES_LIMIT).optional(),
        autoEval: ProductAutoEvalSchema.optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await products.create({
            tenant: ws,
            createdBy: principal.subject,
            name: a.name,
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.icon !== undefined ? { icon: a.icon } : {}),
            ...(a.services !== undefined ? { services: a.services } : {}),
            ...(a.series !== undefined ? { series: a.series } : {}),
            ...(a.autoEval !== undefined ? { autoEval: a.autoEval } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_products",
    {
      description: "The workspace's products, newest activity first.",
      inputSchema: {},
    },
    () => run(principal, "issues:read", async () => ok(await products.list(ws))),
  );

  server.registerTool(
    "get_product",
    {
      description:
        "One product with every release and the visible slice of its imported version ledger — the read that " +
        "answers 'what composes this product and what has moved lately'.",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "issues:read", async () => ok(await products.detail(ws, a.id))),
  );

  server.registerTool(
    "list_product_repo_options",
    {
      description:
        "The repositories a product's tracked service may point at — the workspace GitHub App's installation " +
        "repos, exactly the set the version sync can reach. Empty = no App installed.",
      inputSchema: {},
    },
    () =>
      run(principal, "issues:write", async () => {
        if (!deps.githubAppService) return ok([]);
        try {
          const repos = await deps.githubAppService.listRepos(ws);
          return ok(
            repos.map((repo) => ({
              fullName: repo.fullName,
              ...(repo.host !== undefined ? { host: repo.host } : {}),
              private: repo.private,
            })),
          );
        } catch {
          return ok([]);
        }
      }),
  );

  server.registerTool(
    "list_product_versions",
    {
      description:
        "A product's imported service versions, newest published first (the remote's own clock). Filter by " +
        "service name.",
      inputSchema: {
        id: z.string(),
        service: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    (a) =>
      run(principal, "issues:read", async () =>
        ok(
          await products.listVersions(ws, a.id, {
            ...(a.service !== undefined ? { service: a.service } : {}),
            ...(a.limit !== undefined ? { limit: a.limit } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_product_timeline",
    {
      description:
        "The product's time axis in one read: releases (past + planned), the windowed version ledger, each " +
        "watch series' scorecard points (oldest first, with pass rate and the triggering service version), " +
        "and linked issues' lifecycle markers. Default window: the last 90 days. This is the read that " +
        "answers 'how has the product moved between releases'.",
      inputSchema: {
        id: z.string(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      },
    },
    (a) =>
      run(principal, "issues:read", async () =>
        ok(
          await products.timeline(ws, a.id, {
            ...(a.from !== undefined ? { from: a.from } : {}),
            ...(a.to !== undefined ? { to: a.to } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "update_product",
    {
      description:
        "Edit a product's content (name, description, icon, services, series, autoEval). Lists replace what " +
        "is there. A re-declared service keeps its sync watermark unless its repository/source/prefix changed.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(10_000).nullable().optional(),
        icon: z.string().max(8).nullable().optional(),
        services: z.array(ProductServiceBodySchema).max(50).optional(),
        series: z.array(ProductSeriesSchema).max(PRODUCT_SERIES_LIMIT).optional(),
        autoEval: ProductAutoEvalSchema.optional(),
      },
    },
    ({ id, ...fields }) => run(principal, "issues:write", async () => ok(await products.update(ws, id, fields, actor))),
  );

  server.registerTool(
    "delete_product",
    {
      description:
        "Delete a product (creator or workspace admin only). Its releases and version ledger cascade with it.",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        await products.remove(ws, a.id, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        });
        return ok({ deleted: true });
      }),
  );

  server.registerTool(
    "sync_product_versions",
    {
      description:
        "Pull the tracked services' releases/tags from GitHub now (everdict is the client — no webhook). The " +
        "first sync of a service backfills the timeline's past silently; after that each genuinely new version " +
        "emits product.service_version_imported and, with auto-eval enabled, submits one scorecard per watched " +
        "series stamped with product/series/version provenance. Per-service soft-fail.",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        if (!deps.productVersionSync) throw new Error("product sync not configured");
        return ok(await deps.productVersionSync.sync(ws, a.id, { subject: principal.subject }));
      }),
  );

  server.registerTool(
    "create_release",
    {
      description:
        "Plan a release — a checkpoint on the product's axis with a name, a target date, and which watch " +
        "series it is judged by (absent = every series). It starts `planned`; shipping goes through " +
        "set_release_status, which gates on open linked issues and regressed series.",
      inputSchema: {
        productId: z.string(),
        name: z.string().min(1).max(200),
        description: z.string().max(10_000).optional(),
        targetDate: CalendarDate.optional(),
        seriesKeys: z.array(z.string().min(1)).max(50).optional(),
      },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await products.createRelease({
            tenant: ws,
            createdBy: principal.subject,
            productId: a.productId,
            name: a.name,
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.targetDate !== undefined ? { targetDate: a.targetDate } : {}),
            ...(a.seriesKeys !== undefined ? { seriesKeys: a.seriesKeys } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_releases",
    {
      description:
        "The workspace's releases across every product, newest plan first — what exists to attach an issue " +
        "to or to ask readiness of. Optionally narrowed to one product.",
      inputSchema: { product: z.string().optional() },
    },
    (a) => run(principal, "issues:read", async () => ok(await products.listReleases(ws, a.product))),
  );

  server.registerTool(
    "get_release",
    {
      description:
        "One release plus its readiness: open issues linked to the release, and every watched series' latest " +
        "scorecard against the baseline anchored at the previous ship. Unmeasured never reads as regressed. " +
        "This is the read that answers 'can we ship'.",
      inputSchema: { id: z.string() },
    },
    (a) => run(principal, "issues:read", async () => ok(await products.releaseDetail(ws, a.id))),
  );

  server.registerTool(
    "update_release",
    {
      description:
        "Edit a release's content (name, description, target date, watched series). `seriesKeys: null` clears " +
        "the selection back to every series.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(10_000).nullable().optional(),
        targetDate: CalendarDate.nullable().optional(),
        seriesKeys: z.array(z.string().min(1)).max(50).nullable().optional(),
      },
    },
    ({ id, ...fields }) =>
      run(principal, "issues:write", async () => ok(await products.updateRelease(ws, id, fields, actor))),
  );

  server.registerTool(
    "set_release_status",
    {
      description:
        "Move a release between planned / released / cancelled. Releasing is a GATE: it refuses while issues " +
        "linked to the release are open or a watched series has regressed against the previous ship — unless " +
        "force: true, which is recorded on the fact and in the history. A released release cannot reopen.",
      inputSchema: { id: z.string(), status: ReleaseStatusSchema, force: z.boolean().optional() },
    },
    (a) =>
      run(principal, "issues:write", async () =>
        ok(
          await products.setReleaseStatus(
            ws,
            a.id,
            { status: a.status, ...(a.force !== undefined ? { force: a.force } : {}) },
            actor,
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_release",
    {
      description: "Delete a release (creator or workspace admin only).",
      inputSchema: { id: z.string() },
    },
    (a) =>
      run(principal, "issues:write", async () => {
        await products.removeRelease(ws, a.id, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        });
        return ok({ deleted: true });
      }),
  );
}
