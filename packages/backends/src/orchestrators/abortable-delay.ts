// A cancellable delay — resolves after ms, or immediately when the signal aborts, so a polling loop re-checks
// `signal.aborted` on its next turn instead of sleeping out the whole interval. Cleans up its listener either way.
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
