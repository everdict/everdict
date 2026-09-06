#!/usr/bin/env node
// Claude Code SessionStart hook — makes sure an OTLP sink is listening before this session's first export.
//
// `.claude/settings.json` turns telemetry on for every session, and `scripts/telemetry/README.md` says in so
// many words what that bought while nothing listened: "exports are dropped silently when `pnpm telemetry` is
// not running, and the exporting session is not told." The 2026-09-06 audit read the ledger: two probe lines
// from the day the sink was written, and nothing since. Three indicators — concurrent sessions, steering
// against waiting, tool decisions denied — were configured, emitted, and thrown away, because the collector
// was a command somebody had to remember to run in a second terminal.
//
// So the session starts it. Probe the port; if nothing answers, spawn the sink detached and let it outlive
// this process. Says something ONLY when it did something or could not: a SessionStart hook's stdout lands
// in the session's context, and the eval runner starts twenty sessions a run — twenty copies of "already
// listening" would be noise in the very transcripts the suite judges.
//
// Never exits non-zero. A session that cannot start its collector is still a session; the loss is one line
// in a ledger, and blocking work over it would be the wrong trade.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.EVERDICT_TELEMETRY_PORT ?? 4318);
const HOST = "127.0.0.1";

const listening = () =>
  new Promise((resolve) => {
    const socket = connect({ port: PORT, host: HOST });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });

if (await listening()) process.exit(0);

const child = spawn(process.execPath, [path.join(here, "otlp-sink.mjs")], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
child.unref();

// Give it a moment to bind, then say what happened — the one line the person at the keyboard gets.
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (await listening()) {
    console.log(
      `telemetry sink started (pid ${child.pid}) on ${HOST}:${PORT} — session facts go to .git/everdict-telemetry.jsonl`,
    );
    process.exit(0);
  }
}
console.log(
  `telemetry sink could not be started on ${HOST}:${PORT}; this session's telemetry is being dropped. Run \`pnpm telemetry\` to see why.`,
);
process.exit(0);
