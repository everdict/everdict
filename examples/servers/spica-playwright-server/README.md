# spica-playwright-server

A session API over **spica-client's remote mode**. It is not a Playwright wrapper: a caller asks for *N
browsers* and gets back *N session ids the extension issued*, because the id only exists after the panel
has been walked into remote mode. Managing those sessions — capacity, timeouts, zombies, process
cleanup — is the server's job.

```
POST /start-browser {count: 8}
  └─ 8x: launch Chromium (--load-extension) → open the side panel → menu → remote view → start
         → wait for the work tab → read the session id from the panel
  └─ all 8 or none (a partial batch rolls back)
→ {"session_ids": ["…", …]}
```

## Endpoints

| | |
|---|---|
| `GET /health` | liveness + occupancy (also the container healthcheck) |
| `POST /start-browser` | `{count}` → start a batch, activate remote mode, return `session_ids` |
| `POST /stop-browser/{session_id}?force=` | stop one; `force=true` kills the browser tree and drops the session even if it will not close |
| `POST /navigate` | `{session_id, url}` — `http`/`https` only |
| `GET /status/{session_id}` | `status`, `uptime_seconds`, `close_failure_count`, `cdp_url` |
| `GET /browsers` | every live session |
| `GET /state` | `max_browsers`, timeout, cleanup interval, occupancy |
| `PATCH /state` | change those at runtime (a cap below what is running → `409`) |
| `GET /debug/processes` | every Chrome process, the session whose profile it holds, and unclaimed profiles |

Errors are `{code, message, details}`: `404` unknown session · `409` capacity/duplicate · `400` bad
input · `502` the browser came up but remote mode did not.

## Layout

```
api/             routes, request/response models, the only place status codes exist
core/            sessions, registry (capacity), service (start/stop/navigate/sweep), cleanup loop
infrastructure/  Chromium launch, extension identity, remote-mode automation, OS processes, CDP bridge
client/          BrowserClient — async context manager
```

## What this server actually has to get right

**Capacity is reserved before a launch, not counted after.** A launch takes seconds and the session id
arrives last, so counting registered sessions would let two concurrent batches both pass the check and
both launch. Reservations are what make `max_browsers` a limit rather than a suggestion.

**A partial batch is a failure.** Eight browsers were asked for because eight agents are about to run;
five is not a smaller success. Any failure rolls the whole batch back to zero.

**A repeated session id is refused.** The extension issues the id, so two browsers reporting the same one
means activation handed out a stale/shared session — accepting it would silently alias two browsers
behind one address.

**One profile per session.** Chrome takes an exclusive lock on a profile directory, so a shared one is a
hard failure the moment two browsers start. Each session gets `USER_DATA_DIR/profile-<random>`, removed
when it stops (unbounded profile directories otherwise fill the disk).

**Sessions expire.** Callers crash. A timed-out session still holds a slot, so the sweeper force-removes
it every `CLEANUP_INTERVAL_MINUTES` — otherwise the advertised capacity quietly shrinks toward zero.

**Closing is not the same as gone.** `context.close()` is the normal path; when it fails the session is
kept (not deregistered) and `close_failure_count` goes up, because forgetting a browser that is still
holding a profile lock is how a container leaks. `force=true` then finds the Chrome tree by its
`--user-data-dir` and kills it. `GET /debug/processes` is the read that shows the difference between
"the registry is clean" and "this container is clean".

## Configuration

| env | default | |
|---|---|---|
| `EXTENSION_PATH` | `/ext` | the built extension (`.output/chrome-mv3`) |
| `USER_DATA_DIR` | `/tmp/spica-profiles` | profile root; one directory per session |
| `MAX_CONCURRENT_BROWSERS` | `8` | the cap; also `PATCH /state` |
| `SESSION_TIMEOUT_MINUTES` | `15` | past this a session is swept as a zombie |
| `CLEANUP_INTERVAL_MINUTES` | `1` | sweeper period |
| `SPICA_PLAYWRIGHT_BROWSER_VISIBLE` | `0` | `1` shows windows on the display instead of parking them off-screen |
| `SPICA_PANEL_PATH` | `sidepanel.html` | panel document inside the extension |
| `SPICA_MENU_SELECTOR` | `[data-testid='menu-button']` | ⬐ |
| `SPICA_REMOTE_VIEW_SELECTOR` | `[data-testid='remote-view-link']` | the activation click-through |
| `SPICA_START_SELECTOR` | `[data-testid='remote-start-button']` | ⬑ |
| `SPICA_SESSION_ID_SELECTOR` | `[data-session-id]` | where the id is read (attribute first, then text) |
| `SPICA_ACTIVATION_TIMEOUT_MS` | `60000` | per activation step |
| `SPICA_CDP_EXPOSE` | `0` | `1` publishes each session's DevTools port |
| `SPICA_CDP_ADVERTISED_HOST` | `127.0.0.1` | the host to put in `cdp_url` |
| `SPICA_CLIENT_REPO` / `SPICA_CLIENT_REF` | — | build the extension at start instead of mounting it |

**The five `SPICA_*_SELECTOR` values are the integration point.** They describe spica-client's panel, not
this server, so a panel redesign is an env change rather than a release. They are also the least verified
part of this code — the activation flow was written against the documented sequence (menu → remote view →
start → work tab), and needs a real extension build to confirm.

## Run

```bash
docker build -t spica-playwright-server:0.1.0 .
docker run --rm -p 8080:8080 -v /path/to/chrome-mv3:/ext:ro spica-playwright-server:0.1.0

curl -s localhost:8080/health
curl -s -XPOST localhost:8080/start-browser -H 'content-type: application/json' -d '{"count": 4}'
```

Locally (needs a display or `xvfb-run`):

```bash
uv sync
EXTENSION_PATH=/path/to/chrome-mv3 uv run python -m spica_playwright_server
uv run pytest          # unit tests; they launch no browser
```

## Client

```python
from spica_playwright_server.client import BrowserClient

async with BrowserClient("http://localhost:8080", count=4) as browsers:
    for session_id in browsers.session_ids:
        await browsers.navigate("https://example.com", session_id)
# every session is force-stopped on the way out, including after an exception
```

## Watching a session from outside (`SPICA_CDP_EXPOSE=1`)

With exposure on, each session allocates a debugging port and `cdp_url` in `/start-browser` and
`/status/{id}` carries an address reachable from outside the container. Chrome binds that port to
`127.0.0.1` and ignores requests to bind it wider, so a `socat` forwarder per session is what makes the
address real — set `SPICA_CDP_ADVERTISED_HOST` to the name other containers use to reach this one.

For Everdict this is the field a service-acquired target reads:

```json
"acquire": {
  "mode": "service", "service": "spica-playwright",
  "open": "POST /start-browser",
  "coordinates": { "session_id": "session_ids.0" },
  "close": "POST /stop-browser/{session_id}?force=true",
  "cdpBase": "sessions.0.cdp_url"
}
```

That one `cdpBase` line is what turns the run detail's live screen and the environment recorder
(network/console/navigation + screencast) on for the case driving this session — see
`docs/architecture/live-observability.md`.
