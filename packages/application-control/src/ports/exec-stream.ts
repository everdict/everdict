// A live interactive shell stream inside a case container (observability ⑥) — the WS terminal route drives it.
// PORT: the same structural contract @everdict/backends' Shellable.execStream produces; RunService returns it from
// openTerminal (the injected openTerminalStream dep supplies it). The application layer must not import
// @everdict/backends, so the type lives here (re-architecture P2 S5). apps/api's backend value satisfies it
// structurally — no cast. Lifecycle = the WS connection: exactly one consumer, torn down by close(), so there is
// no unsubscribe (that, and a full Node-stream/backpressure model, are deliberate non-goals). write() is
// best-effort fire-and-forget.
export interface ExecStreamHandle {
  write(data: string): void; // forward the terminal's keystrokes to the shell's stdin (dropped if the shell already exited)
  onData(cb: (chunk: string) => void): void; // shell stdout/stderr → the terminal
  onError(cb: (err: Error) => void): void; // transport/spawn failure (distinct from a clean exit) — otherwise it is lost
  onExit(cb: (code: number | null) => void): void; // the shell exited (or the container died)
  close(): void; // tear down (WS closed / run terminal)
}
