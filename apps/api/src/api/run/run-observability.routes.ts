import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, runVisible, sendError } from "../route-context.js";
import { runObservabilityDocs } from "./run-observability.docs.js";

// run observability — live progress into a run's sandbox: logs snapshot/stream, one-shot exec,
// the WS-terminal ticket mint, and the live screen frame. Creator-or-admin gated per route.

// ?stream= → the job output stream to tail. Default stdout; stderr = harness progress logs (many harnesses
// log there while stdout carries only the result block). Anything else = undefined (caller 400s if it was set).
function parseLogStream(raw: string | undefined): "stdout" | "stderr" | undefined {
  if (raw === undefined) return "stdout";
  return raw === "stdout" || raw === "stderr" ? raw : undefined;
}

export function registerRunObservabilityRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- live-progress logs (observability ②) — the case job's current stdout, sentinel-stripped ---
  // Snapshot: poll-and-diff clients (web) read this. found=false = nothing to tail yet (queued / GC'd / no backend support).
  app.get<{ Params: { id: string }; Querystring: { stream?: string } }>(
    "/runs/:id/logs",
    { schema: runObservabilityDocs.logs },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const stream = parseLogStream(req.query.stream);
        if (stream === undefined && req.query.stream !== undefined)
          return reply.code(400).send({ code: "BAD_REQUEST", message: "stream must be stdout or stderr." });
        const out = await deps.service.logs(req.params.id, stream);
        if (!out || !runVisible(out.record, principal))
          return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
        return reply.send({ status: out.record.status, found: out.text !== undefined, text: out.text ?? "" });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Live trajectory (observability ⑨) — the run's own TraceEvents accumulating while it runs: dispatch placement
  // marks + runner-pushed batches + the managed job's event-sentinel stdout lines. A preview of the evidence that
  // seals at settle. Same visibility as every run read (runVisible → 404).
  //
  // INCREMENTAL where it can be: the pushed lane is append-only, so `?after=<cursor>` serves what arrived since
  // and the reply says `incremental: true`. The pulled lane (a managed job's stdout) is re-read whole every
  // time and says `incremental: false`, so a reader knows to replace instead of append. One poll used to cost
  // the whole buffer whatever had changed, which on a long agent run is the entire cost of the panel.
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/runs/:id/trajectory/live",
    { schema: runObservabilityDocs.liveTrace },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        // `after` is the reader's absolute cursor from its previous poll. Absent = first poll (the whole
        // window); present = "what is new", which is what keeps a three-second poll on a five-hour run from
        // re-shipping the buffer every time. A non-numeric value is treated as absent rather than refused —
        // the worst it can cost is one redundant full page, and a live panel should not 400 on a stale link.
        const rawAfter = (req.query as { after?: string }).after;
        const after = rawAfter !== undefined && /^\d+$/.test(rawAfter) ? Number(rawAfter) : undefined;
        const out = await deps.service.liveTrace(req.params.id, after);
        if (!out || !runVisible(out.record, principal))
          return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
        return reply.send({
          status: out.record.status,
          found: out.events.length > 0,
          events: out.events,
          // The reader appends only when the server says this page continues what it already holds.
          incremental: out.incremental,
          from: out.from,
          next: out.next,
          total: out.total,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Case-scoped placement (runtime debugging): where the run's case job stands INSIDE its runtime cluster —
  // queued / blocked (with the scheduler's capacity verdict) / starting / running / dead, the node, and the
  // orchestrator event feed. found=false = nothing to describe (pre-dispatch / GC'd / no backend support).
  app.get<{ Params: { id: string } }>(
    "/runs/:id/placement",
    { schema: runObservabilityDocs.placement },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const out = await deps.service.placement(req.params.id);
        if (!out || !runVisible(out.record, principal))
          return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
        return reply.send({
          status: out.record.status,
          found: out.placement !== undefined,
          placement: out.placement ?? null,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Topology health roster (runtime debugging, service harnesses): the live per-service state of the warm
  // topology the run drives — restart churn, OOM kills, last notable event per service. found=false = not a
  // service harness / no topology runtime behind the lane / the read degraded.
  app.get<{ Params: { id: string } }>(
    "/runs/:id/topology",
    { schema: runObservabilityDocs.topology },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const out = await deps.service.topology(req.params.id);
        if (!out || !runVisible(out.record, principal))
          return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
        return reply.send({
          status: out.record.status,
          found: out.topology !== undefined,
          topology: out.topology ?? null,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // One deployed topology service's current log tail — the service-level twin of /runs/:id/logs ("the stack is
  // up but the case fails: what is the SERVICE saying"). found=false = no live unit for that service.
  app.get<{ Params: { id: string; service: string } }>(
    "/runs/:id/topology/services/:service/logs",
    { schema: runObservabilityDocs.topologyServiceLogs },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const out = await deps.service.topologyServiceLogs(req.params.id, req.params.service);
        if (!out || !runVisible(out.record, principal))
          return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
        return reply.send({ found: out.text !== undefined, text: out.text ?? "" });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // One-shot exec into a run's live sandbox (observability ④ — web terminal). Runs `sh -c command` in the case
  // container. The sandbox is untrusted+isolated, so WHO may exec is tightened beyond runs:read: the run's
  // creator or a workspace admin only. found=false = no live container to exec into.
  app.post<{ Params: { id: string }; Body: { command?: string } }>(
    "/runs/:id/exec",
    { schema: runObservabilityDocs.exec },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const command = req.body?.command;
        if (typeof command !== "string" || command.trim() === "")
          return reply.code(400).send({ code: "BAD_REQUEST", message: "command is required." });
        const out = await deps.service.exec(req.params.id, command);
        if (!out || !runVisible(out.record, principal))
          return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
        // Creator-or-admin — exec runs arbitrary commands in the sandbox (mutating), stricter than a read.
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return reply.code(403).send({ code: "FORBIDDEN", message: "only the run's creator or an admin can exec." });
        if (!out.result) return reply.send({ found: false, stdout: "", stderr: "", exitCode: null });
        return reply.send({ found: true, ...out.result });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Interactive terminal ticket (observability ⑥) — a browser can't send an Authorization header on a WS, so an
  // authenticated (creator-or-admin) POST mints a short-lived single-use ticket; the browser then opens
  // WS /runs/:id/terminal?ticket=… . Same gate as exec.
  app.post<{ Params: { id: string } }>(
    "/runs/:id/terminal-ticket",
    { schema: runObservabilityDocs.terminalTicket },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        if (!deps.terminalTickets)
          return reply.code(404).send({ code: "NOT_FOUND", message: "terminal not configured" });
        const rec = await deps.service.get(req.params.id);
        if (!rec || !runVisible(rec, principal))
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
    },
  );

  // Interactive takeover ticket (observability ⑦b) — mints the short-lived credential for WS /runs/:id/screen,
  // which drives the run's own browser. Gated exactly like exec: this is not watching, it is acting inside a live
  // eval, so it is the run's creator or a workspace admin. A run with nothing attachable is 404 here rather than
  // handing out a ticket that the upgrade would then refuse.
  app.post<{ Params: { id: string } }>(
    "/runs/:id/screen-ticket",
    { schema: runObservabilityDocs.screenTicket },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        if (!deps.screenTickets)
          return reply.code(404).send({ code: "NOT_FOUND", message: "interactive screen not configured" });
        const out = await deps.service.screenEndpoint(req.params.id);
        if (!out || !runVisible(out.record, principal))
          return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return reply
            .code(403)
            .send({ code: "FORBIDDEN", message: "only the run's creator or an admin can take over the screen." });
        if (!out.endpoint)
          return reply.code(404).send({ code: "NOT_FOUND", message: "this run has no live screen to attach to." });
        return reply.send({ ticket: deps.screenTickets.issue(req.params.id, principal.subject) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Live screen frame (observability ⑤ — os-use desktop): current screenshot as a PNG data URL. supported=false
  // for non-desktop env kinds (no single-container screen). Same creator-or-admin gate as exec (it execs scrot).
  app.get<{ Params: { id: string } }>(
    "/runs/:id/screen",
    { schema: runObservabilityDocs.screen },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const out = await deps.service.screen(req.params.id);
        if (!out || !runVisible(out.record, principal))
          return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return reply
            .code(403)
            .send({ code: "FORBIDDEN", message: "only the run's creator or an admin can view the screen." });
        // status lets the client stop polling once the run is terminal (a live screen only exists while it runs).
        return reply.send({
          status: out.record.status,
          supported: out.supported,
          found: out.dataUrl !== undefined,
          dataUrl: out.dataUrl ?? "",
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Live repo file tree (run workbench — the explorer half of the "VS Code view" on a coding case). Same
  // creator-or-admin gate as exec: it reads the sandbox's working tree. found=false = no live container, or
  // the sandbox has no git worktree (non-repo env kinds) — the client renders nothing.
  app.get<{ Params: { id: string } }>("/runs/:id/fs", { schema: runObservabilityDocs.fs }, async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const out = await deps.service.fsTree(req.params.id);
      if (!out || !runVisible(out.record, principal))
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
        return reply
          .code(403)
          .send({ code: "FORBIDDEN", message: "only the run's creator or an admin can browse the sandbox files." });
      return reply.send({
        status: out.record.status,
        found: out.tree !== undefined,
        files: out.tree?.files ?? [],
        truncated: out.tree?.truncated ?? false,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // One file of that live repo, with its working-tree diff riding along (the editor half of the workbench).
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/runs/:id/fs/file",
    { schema: runObservabilityDocs.fsFile },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const path = req.query.path;
        if (typeof path !== "string" || path === "")
          return reply.code(400).send({ code: "BAD_REQUEST", message: "path query parameter is required." });
        // Path FORMAT (traversal, absolute, control chars) is the service's one rule — BadRequestError → 400.
        const out = await deps.service.fsFile(req.params.id, path);
        if (!out || !runVisible(out.record, principal))
          return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return reply
            .code(403)
            .send({ code: "FORBIDDEN", message: "only the run's creator or an admin can read the sandbox files." });
        return reply.send({
          status: out.record.status,
          found: out.file !== undefined,
          path,
          size: out.file?.size ?? 0,
          binary: out.file?.binary ?? false,
          truncated: out.file?.truncated ?? false,
          content: out.file?.content ?? "",
          diff: out.file?.diff ?? "",
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Replay recording (docs/architecture/replay.md): the sealed screen frames + logs + env/runtime tracks of a
  // settled run. Creator-or-admin gated (it contains screenshots), same as the live screen; requires runs:read.
  app.get<{ Params: { id: string } }>(
    "/runs/:id/recording",
    { schema: runObservabilityDocs.recording },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const out = await deps.service.recording(req.params.id);
        if (!out || !runVisible(out.record, principal))
          return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
        if (out.record.createdBy && out.record.createdBy !== principal.subject && !principal.roles.includes("admin"))
          return reply
            .code(403)
            .send({ code: "FORBIDDEN", message: "only the run's creator or an admin can view the recording." });
        return reply.send({
          status: out.record.status,
          found: out.recording !== undefined,
          recording: out.recording ?? null,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Multiplexed live feed (SSE): ONE connection replaces the live view's per-widget pollers. Every ~2.5s the
  // server reads the lanes the client asked for (?lanes=screen,trace,fs — default trace) and emits only what
  // CHANGED since the last tick (`event: <lane>` + JSON data), plus `event: status` transitions and a final
  // `event: end`. Idle lanes cost heartbeat comments only. Creator-or-admin gated (screen/fs read the sandbox),
  // like the strictest lane it can carry. docs/architecture/replay.md ④.
  app.get<{ Params: { id: string }; Querystring: { lanes?: string } }>(
    "/runs/:id/live/stream",
    { schema: runObservabilityDocs.liveStream },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
      } catch (err) {
        return sendError(reply, err);
      }
      const record = await deps.service.get(req.params.id);
      if (!record || !runVisible(record, principal))
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      if (record.createdBy && record.createdBy !== principal.subject && !principal.roles.includes("admin"))
        return reply
          .code(403)
          .send({ code: "FORBIDDEN", message: "only the run's creator or an admin can attach the live stream." });
      const lanes = new Set(
        (req.query.lanes ?? "trace")
          .split(",")
          .map((l) => l.trim())
          .filter((l) => l === "screen" || l === "trace" || l === "fs"),
      );
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
      const TERMINAL = new Set(["succeeded", "failed", "superseded"]);
      const emit = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      // Per-lane change tracking — an unchanged lane emits nothing (the wire carries deltas, not snapshots).
      let lastStatus = "";
      let lastScreen = "";
      let sentTrace = 0;
      let lastFs = "";
      let status = record.status;
      while (!closed) {
        let ticked = false;
        try {
          const live = await deps.service.liveTrace(req.params.id);
          if (!live) break;
          status = live.record.status;
          if (status !== lastStatus) {
            lastStatus = status;
            emit("status", { status });
            ticked = true;
          }
          if (lanes.has("trace") && live.events.length > sentTrace) {
            emit("trace", { events: live.events.slice(sentTrace), total: live.events.length });
            sentTrace = live.events.length;
            ticked = true;
          }
          if (lanes.has("screen")) {
            const screen = await deps.service.screen(req.params.id).catch(() => undefined);
            const dataUrl = screen?.dataUrl ?? "";
            if (dataUrl !== "" && dataUrl !== lastScreen) {
              lastScreen = dataUrl;
              emit("screen", { dataUrl });
              ticked = true;
            }
          }
          if (lanes.has("fs")) {
            const fs = await deps.service.fsTree(req.params.id).catch(() => undefined);
            if (fs?.tree) {
              const key = JSON.stringify(fs.tree.files);
              if (key !== lastFs) {
                lastFs = key;
                emit("fs", { files: fs.tree.files, truncated: fs.tree.truncated });
                ticked = true;
              }
            }
          }
        } catch {
          break; // a read that stops answering ends the stream; the client reconnects or falls back to polling
        }
        if (TERMINAL.has(status)) break;
        if (!ticked) reply.raw.write(": hb\n\n");
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (!closed) {
        reply.raw.write(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
        reply.raw.end();
      }
    },
  );

  // SSE tail: emits appended log chunks (JSON-encoded strings — newline-safe) every ~2s until the run is
  // terminal, then `event: end` with the final status. Heartbeat comments keep proxies from idling out.
  app.get<{ Params: { id: string }; Querystring: { stream?: string } }>(
    "/runs/:id/logs/stream",
    { schema: runObservabilityDocs.logsStream },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
      } catch (err) {
        return sendError(reply, err);
      }
      const stream = parseLogStream(req.query.stream);
      if (stream === undefined && req.query.stream !== undefined)
        return reply.code(400).send({ code: "BAD_REQUEST", message: "stream must be stdout or stderr." });
      let out = await deps.service.logs(req.params.id, stream);
      if (!out || !runVisible(out.record, principal))
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
        const next = await deps.service.logs(req.params.id, stream).catch(() => undefined);
        if (!next) break;
        out = next;
        emit(out.text ?? "");
      }
      if (!closed) {
        reply.raw.write(`event: end\ndata: ${JSON.stringify({ status: out.record.status })}\n\n`);
        reply.raw.end();
      }
    },
  );
}
