// Stub front-door service: 200 (JSON) on every request. GET /health (rollout readiness) + POST /runs (front-door submit drive).
const http = require("node:http");
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      console.log(`${req.method} ${req.url} ${body.slice(0, 200)}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, method: req.method, path: req.url }));
    });
  })
  .listen(8080, () => console.log("stub front-door on :8080"));
