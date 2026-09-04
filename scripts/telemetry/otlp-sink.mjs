#!/usr/bin/env node
// A dependency-free OTLP/HTTP receiver, so this repository can collect its own agent telemetry with nothing
// to stand up. `pnpm telemetry` starts it; a session exporting to it appends one JSON line per payload to
// `.git/everdict-telemetry.jsonl`.
//
// This exists because it is the ONE measurement gap that cannot be closed by writing a check: how many
// sessions ran at once, how much of a session was steering rather than waiting, which tool decisions were
// denied. Those facts are produced outside every process this repository controls, and the agent emits them
// as OpenTelemetry or not at all. The recipe is in `scripts/telemetry/README.md`.
//
// Accepts `http/json` only. That is not a limitation worth removing: protobuf would need a dependency and a
// schema, and the point of this file is that collecting starts today rather than after someone stands up a
// collector.
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(root, ".git", "everdict-telemetry.jsonl");
const PORT = Number(process.env.EVERDICT_TELEMETRY_PORT ?? 4318);

const SIGNALS = new Set(["/v1/traces", "/v1/metrics", "/v1/logs"]);
let received = 0;

const server = createServer((req, res) => {
  if (req.method !== "POST" || !SIGNALS.has(req.url ?? "")) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not an OTLP signal path"}');
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      // Record it anyway rather than dropping it: an undecodable payload is a fact about the exporter, and a
      // sink that silently discards what it cannot parse is the shape of thing this whole harness refuses.
      payload = { undecodable: body.slice(0, 2000) };
    }
    try {
      appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), signal: req.url, payload })}\n`);
      received++;
      process.stdout.write(`· ${received} payload(s) · ${req.url}\r`);
    } catch (err) {
      process.stderr.write(`\n✖ telemetry: could not append to ${path.relative(root, OUT)} — ${err.message}\n`);
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});

// A sink that silently loses a port race looks exactly like a sink that is working, and the session exporting
// into nothing would report success. Refuse instead, and say which port.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `✖ telemetry: port ${PORT} is already in use. Another sink is probably running — stop it, or set EVERDICT_TELEMETRY_PORT.\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`✖ telemetry: ${err.message}\n`);
  process.exit(1);
});

mkdirSync(path.dirname(OUT), { recursive: true });
server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`▶ OTLP sink on http://127.0.0.1:${PORT} → ${path.relative(root, OUT)}\n`);
  process.stdout.write("  Nothing is collected while this is not running, and the exporting session is not told.\n");
});
