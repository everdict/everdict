// Per-runtime circuit breaker — the health memory behind batch runtime spillover.
//
// Every retryable-infra dispatch failure against a runtime increments its consecutive-failure count; at the
// threshold the circuit OPENS and stays open for a cooldown, during which callers skip the runtime instead of
// re-discovering the outage one timeout at a time (601 cases × a dead cluster = 601 timeouts without this).
// After the cooldown the circuit is HALF-OPEN: `isOpen` reports false so exactly the next attempt probes the
// runtime — a success closes the circuit, a failure re-opens it for a fresh cooldown (the consecutive count is
// already at the threshold, so one more `failure()` re-arms `openedAt`).
//
// Keys are caller-defined strings (the API layer keys by `tenant:runtimeId` — runtime ids are tenant-scoped).
// The breaker only records what callers tell it: callers must report INFRA failures only — an agent FAIL or a
// config error says nothing about the runtime's health.
export interface CircuitBreakerOpts {
  threshold?: number; // consecutive infra failures that open the circuit
  cooldownMs?: number; // how long an open circuit rejects before allowing a half-open probe
  now?: () => number; // injectable clock (tests)
  onOpen?: (key: string) => void; // observability hook — fired on every closed→open (and half-open→re-open) transition
}

interface CircuitState {
  consecutive: number;
  openedAt?: number;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private readonly circuits = new Map<string, CircuitState>();

  constructor(private readonly opts: CircuitBreakerOpts = {}) {
    this.threshold = opts.threshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.clock = opts.now ?? (() => Date.now());
  }

  failure(key: string): void {
    const state = this.circuits.get(key) ?? { consecutive: 0 };
    state.consecutive += 1;
    if (state.consecutive >= this.threshold) {
      const wasOpen = this.isOpen(key);
      state.openedAt = this.clock();
      if (!wasOpen) this.opts.onOpen?.(key); // transition only — re-arming an already-open circuit is not a new trip
    }
    this.circuits.set(key, state);
  }

  success(key: string): void {
    this.circuits.delete(key);
  }

  // Open = rejecting. False either means healthy or "half-open, let one probe through" — callers don't need to
  // tell those apart: they just try, and failure()/success() settles the circuit's fate.
  isOpen(key: string): boolean {
    const state = this.circuits.get(key);
    if (state?.openedAt === undefined) return false; // explicit — a 0 timestamp is a real openedAt
    return this.clock() - state.openedAt < this.cooldownMs;
  }

  // Observability snapshot (queue page / logs).
  stats(): Record<string, { consecutive: number; open: boolean }> {
    const out: Record<string, { consecutive: number; open: boolean }> = {};
    for (const [key, state] of this.circuits) out[key] = { consecutive: state.consecutive, open: this.isOpen(key) };
    return out;
  }
}
