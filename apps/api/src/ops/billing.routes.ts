import type { FastifyInstance } from "fastify";
import { BudgetLimitInputSchema } from "../lib/budget-tracker.js";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// billing view — metered LLM usage (meter-only) + the enforcement budget (usage + per-tenant limit; read = member, limit change = admin).
export function registerBillingRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- usage (billing meter) — the workspace's metered LLM cost (orchestration + verdict; own-pays runs excluded). ---
  // Meter-only (never blocks), so this is purely a read. viewer+ (reuses scorecards:read — usage is part of the eval read surface).
  app.get("/usage", async (req, reply) => {
    if (!deps.usageMeter) return reply.code(404).send({ code: "NOT_FOUND", message: "usage meter not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      return reply.send(deps.usageMeter.usage(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Enforcement budget (blocks runs with 402 when a cap is hit; distinct from the meter-only /usage). GET = committed
  // usage + the per-tenant limit — readable by members (viewer+, reuses scorecards:read, same as /usage); PUT =
  // change the limit (admin, settings:write). So members see the caps/usage; only admins edit them.
  app.get("/budget", async (req, reply) => {
    if (!deps.budget) return reply.code(404).send({ code: "NOT_FOUND", message: "budget not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      const ws = principal.workspace;
      return reply.send({ usage: deps.budget.usage(ws), limit: deps.budget.limitOf(ws) ?? null });
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.put("/budget", async (req, reply) => {
    if (!deps.budget) return reply.code(404).send({ code: "NOT_FOUND", message: "budget not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      const parsed = BudgetLimitInputSchema.safeParse(req.body); // a PUT replaces the whole limit (omitted dimension = unlimited)
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      const ws = principal.workspace;
      await deps.budget.setLimit(ws, parsed.data);
      return reply.send({ usage: deps.budget.usage(ws), limit: deps.budget.limitOf(ws) ?? null });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
