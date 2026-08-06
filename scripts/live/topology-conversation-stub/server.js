// Conversation-aware stub front-door: keeps per-thread memory, so a reply PROVES continuity — turn 2 on the
// same thread_id echoes what turn 1 said, while a fresh thread answers empty. GET /health for readiness.
const http = require("node:http");
const threads = new Map();
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/runs") {
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch {
          // keep {} — the reply below then says the request was unreadable
        }
        const thread = String(payload.thread_id ?? "");
        const memory = threads.get(thread) ?? [];
        const reply =
          memory.length > 0 ? `I remember: ${memory.join(" | ")}` : "starting fresh - nothing remembered yet.";
        memory.push(String(payload.task ?? ""));
        threads.set(thread, memory);
        console.log(`POST /runs thread=${thread} turns=${memory.length}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ output: reply, thread_id: thread, run_id: payload.run_id ?? "" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, method: req.method, path: req.url }));
    });
  })
  .listen(8080, () => console.log("conversation front-door on :8080"));
