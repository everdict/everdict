// Minimal `--flag value` / `--flag` (boolean "true") argv parser shared by every CLI command and the standalone
// runner entry. A value that itself starts with `--` is NOT consumed, so `--pair --api-url x` leaves `pair` = "true"
// (the runner then rejects it) — the token must be a positional value: `--pair <rnr_…>`.
export function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, "true");
    }
  }
  return flags;
}
