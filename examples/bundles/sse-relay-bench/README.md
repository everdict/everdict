# sse-relay-bench — parallel topology probe (self-hosted runner)

A **dummy but structurally faithful** browser-use-shaped topology, built to answer one question:
*can a single Everdict self-hosted runner (desktop or CLI — same `@everdict/self-hosted-runner`
core) drive this topology with 8 cases in parallel, correctly and without cross-case interference?*
No LLM calls — the "agent output" is a deterministic message stream, so every case is verifiable by
nonce accounting.

## Topology

```
                    POST /runs (front door, per-run wiring)
  Everdict runner ──────────────────────────────► command (:8000)
        │                                            │ XADD {key_prefix}:chat:{session_id}
        │ POST /sessions/{key_prefix}                ▼
        │  (target.acquire = service)             redis (dependency store, isolateBy=key-prefix)
        ▼                                            │ XREAD
  client-host (:8002)                             relay (:8001)
   FastAPI + Playwright                              │ GET /events/{stream}  (SSE)
   launches Chromium with /ext loaded ──────────► /client page (no JS of its own)
                                                     │ the EXTENSION subscribes, collects,
                                                     │ POST /results/{stream} on "done"
                                                     ▼
                                          redis {key_prefix}:result:{session_id}
                                                     │ XREAD
                                                     ▼
                                       command verifies nonces → poll "done"
                                       (sentinel observation + inline trace)
```

- **command** — the benchmark front door. Publishes `MESSAGE_COUNT` dummy agent chat messages
  (each tagged `run_id`/`session_id`/`seq`/`nonce`) onto the per-session Redis Stream, then awaits
  the client's transcript on the result stream and verifies it: `leaked`/`missing` must be 0.
- **relay** — exposes each session's stream as an SSE endpoint (`/events/{stream}`), serves the
  bare `/client` page, accepts the client's transcript (`/results/{stream}`), and answers the
  `acquire.ready` gate (`/subscribed/{stream}` = 200 iff an SSE consumer is connected).
- **client-host** — the Playwright wrapping server: `POST /sessions/{key_prefix}` (start-browser)
  launches a persistent Chromium with the bundled MV3 extension and points it at the relay page
  wired to a fresh `session_id`. The harness acquires it per case via `target.acquire=service`.
- **extension** — the real client. The `/client` page ships no JavaScript, so a completed loop
  proves the extension loaded: it subscribes to the SSE stream, renders messages into the DOM, and
  reports the transcript upstream.

Isolation is two-keyed: `key_prefix` (per-run, from `dependencies[].isolateBy="key-prefix"`) ×
`session_id` (per browser session, minted by client-host). A message crossing sessions shows up as
`leaked > 0` and fails that case's `answer-match` (`expected: "ok=true"`).

## Build the images (bundle root)

```sh
docker build -t sse-relay-command:v1     command-server
docker build -t sse-relay-relay:v1      relay-server
docker build -t sse-relay-client-host:v1 -f client-host/Dockerfile .
```

## Run it

Apply `bundle.json` (`POST /bundles/apply`), then submit with **both parallelism knobs** set —
each defaults lower than 8:

```jsonc
// POST /scorecards
{
  "dataset": { "id": "sse-relay-parallel", "version": "1.0.0" },
  "harness": { "id": "sse-relay-bench" },
  "runtime": "self:<runnerId>",
  "concurrency": 8            // batch-side: defaults to 4 if omitted
}
```

and run the runner with 8 workers (desktop: the pair-time max-concurrent input; CLI:
`everdict runner --pair … --max-concurrent 8`).

The end-to-end proof lives at `scripts/live/sse-relay-parallel-selfhosted.mjs` — it builds the
images, boots a dev control plane, pairs a runner with 8 workers, runs the 8-case scorecard, and
asserts: all 8 pass leak-free, sessions/SSE streams/agent runs peaked at 8 concurrently, and the
warm topology deployed exactly once (one docker network, one container set).
