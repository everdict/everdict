import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";

// run observability — live progress into a run's sandbox: logs snapshot/stream, one-shot exec,
// the WS-terminal ticket mint, and the live screen frame. Creator-or-admin gated per route.
export function registerRunObservabilityRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- live-progress logs (observability ②) — the case job's current stdout, sentinel-stripped ---
  // Snapshot: poll-and-diff clients (web) read this. found=false = nothing to tail yet (queued / GC'd / no backend support).
  app.get<{ Params: { id: string } }>("/runs/:id/logs", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const out = await deps.service.logs(req.params.id);
      if (!out || out.record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      return reply.send({ status: out.record.status, found: out.text !== undefined, text: out.text ?? "" });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // One-shot exec into a run's live sandbox (observability ④ — web terminal). Runs `sh -c command` in the case
  // container. The sandbox is untrusted+isolated, so WHO may exec is tightened beyond runs:read: the run's
  // creator or a workspace admin only. found=false = no live container to exec into.
  app.post<{ Params: { id: string }; Body: { command?: string } }>("/runs/:id/exec", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const command = req.body?.command;
      if (typeof command !== "string" || command.trim() === "")
        return reply.code(400).send({ code: "BAD_REQUEST", message: "command is required." });
      const out = await deps.service.exec(req.params.id, command);
      if (!out || out.record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      // Creator-or-admin — exec runs arbitrary commands in the sandbox (mutating), stricter than a read.
      if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
        return reply.code(403).send({ code: "FORBIDDEN", message: "only the run's creator or an admin can exec." });
      if (!out.result) return reply.send({ found: false, stdout: "", stderr: "", exitCode: null });
      return reply.send({ found: true, ...out.result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Interactive terminal ticket (observability ⑥) — a browser can't send an Authorization header on a WS, so an
  // authenticated (creator-or-admin) POST mints a short-lived single-use ticket; the browser then opens
  // WS /runs/:id/terminal?ticket=… . Same gate as exec.
  app.post<{ Params: { id: string } }>("/runs/:id/terminal-ticket", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      if (!deps.terminalTickets) return reply.code(404).send({ code: "NOT_FOUND", message: "terminal not configured" });
      const rec = await deps.service.get(req.params.id);
      if (!rec || rec.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      if (rec.createdBy && rec.createdBy !== principal.subject && !principal.roles.includes("admin"))
        return reply
          .code(403)
          .send({ code: "FORBIDDEN", message: "only the run's creator or an admin can attach a terminal." });
      const ticket = deps.terminalTickets.issue(req.params.id, principal.subject);
      return reply.send({ ticket });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Live screen frame (observability ⑤ — os-use desktop): current screenshot as a PNG data URL. supported=false
  // for non-desktop env kinds (no single-container screen). Same creator-or-admin gate as exec (it execs scrot).
  app.get<{ Params: { id: string } }>("/runs/:id/screen", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const out = await deps.service.screen(req.params.id);
      if (!out || out.record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
        return reply
          .code(403)
          .send({ code: "FORBIDDEN", message: "only the run's creator or an admin can view the screen." });
      return reply.send({ supported: out.supported, found: out.dataUrl !== undefined, dataUrl: out.dataUrl ?? "" });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // SSE tail: emits appended log chunks (JSON-encoded strings — newline-safe) every ~2s until the run is
  // terminal, then `event: end` with the final status. Heartbeat comments keep proxies from idling out.
  app.get<{ Params: { id: string } }>("/runs/:id/logs/stream", async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
    } catch (err) {
      return sendError(reply, err);
    }
    let out = await deps.service.logs(req.params.id);
    if (!out || out.record.tenant !== principal.workspace)
      return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let closed = false;
    req.raw.on("close", () => {
      closed = true;
    });
    let sent = 0;
    const emit = (text: string): void => {
      if (text.length <= sent) {
        reply.raw.write(": hb\n\n"); // no new bytes — heartbeat comment
        return;
      }
      reply.raw.write(`data: ${JSON.stringify(text.slice(sent))}\n\n`);
      sent = text.length;
    };
    emit(out.text ?? "");
    const TERMINAL = new Set(["succeeded", "failed", "superseded"]);
    while (!closed && !TERMINAL.has(out.record.status)) {
      await new Promise((r) => setTimeout(r, 2000));
      const next = await deps.service.logs(req.params.id).catch(() => undefined);
      if (!next) break;
      out = next;
      emit(out.text ?? "");
    }
    if (!closed) {
      reply.raw.write(`event: end\ndata: ${JSON.stringify({ status: out.record.status })}\n\n`);
      reply.raw.end();
    }
  });
}
