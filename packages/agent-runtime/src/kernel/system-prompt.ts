import { renderDeferredToolList } from "../tools/deferred.js";
import type { ToolRegistry } from "../tools/registry.js";

// The host supplies the base persona; the kernel appends the not-yet-discovered deferred-tool listing so the
// model knows which tools it can pull in via ToolSearch this turn.
export function buildSystemPrompt(base: string, registry: ToolRegistry, discovered: Set<string>): string {
  const deferred = renderDeferredToolList(registry.list(), discovered);
  return deferred.length > 0 ? `${base}\n\n${deferred}` : base;
}
