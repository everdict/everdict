// /evaluate comment arguments — `key=value` tokens after the command tune the on-demand re-eval without
// editing the workflow: `/evaluate limit=20 tags=smoke,fast trials=3 runtime=self:ws sink=none`.
// Unknown/malformed tokens are WARNINGS (surfaced in the PR reply), never failures — a typo shouldn't cost the fire.
//
//   limit=N        cases.limit (first N of the selection)
//   tags=a,b       cases.tags (any-match)
//   ids=a,b        cases.ids (explicit selection)
//   trials=N       run each case N times (pass@k / flakiness)
//   concurrency=N  in-flight cases for this batch
//   retries=N      transient dispatch retries per case (0–5)
//   runtime=X      runtime override (registered id, comma shard list, "auto", self:…)
//   sink=NAME      per-batch trace-sink override ("none" suppresses export)
export function parseEvaluateArgs(body) {
  const overrides = {};
  const warnings = [];
  const text = String(body ?? "").trim();
  if (!text.startsWith("/evaluate")) return { overrides, warnings };
  const tokens = text
    .slice("/evaluate".length)
    .split(/\s+/)
    .filter(Boolean);
  const setCases = (patch) => {
    overrides.cases = { ...(overrides.cases ?? {}), ...patch };
  };
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq <= 0) {
      warnings.push(`ignored '${tok}' (expected key=value)`);
      continue;
    }
    const key = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    const posInt = Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
    switch (key) {
      case "limit":
        if (posInt) setCases({ limit: posInt });
        else warnings.push(`ignored limit='${value}' (positive integer required)`);
        break;
      case "tags": {
        const tags = value.split(",").filter(Boolean);
        if (tags.length > 0) setCases({ tags });
        else warnings.push("ignored empty tags=");
        break;
      }
      case "ids": {
        const ids = value.split(",").filter(Boolean);
        if (ids.length > 0) setCases({ ids });
        else warnings.push("ignored empty ids=");
        break;
      }
      case "trials":
        if (posInt) overrides.trials = posInt;
        else warnings.push(`ignored trials='${value}' (positive integer required)`);
        break;
      case "concurrency":
        if (posInt) overrides.concurrency = posInt;
        else warnings.push(`ignored concurrency='${value}' (positive integer required)`);
        break;
      case "retries": {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0 && n <= 5) overrides.retries = n;
        else warnings.push(`ignored retries='${value}' (0–5)`);
        break;
      }
      case "runtime":
        if (value) overrides.runtime = value;
        else warnings.push("ignored empty runtime=");
        break;
      case "sink":
        if (value) overrides.traceSink = value;
        else warnings.push("ignored empty sink=");
        break;
      default:
        warnings.push(`ignored unknown key '${key}'`);
    }
  }
  return { overrides, warnings };
}
