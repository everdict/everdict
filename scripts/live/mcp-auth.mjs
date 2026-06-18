// Live: MCP toolization + OAuth auth ("login like Linear MCP") against real Keycloak + apps/api.
// Proves: protected-resource metadata → Keycloak; 401+WWW-Authenticate challenge; Keycloak Bearer (OIDC)
// drives stateful MCP session + role-gated tools; API-key (ak_) Bearer also works on /mcp.
// Run from repo root: node scripts/live/mcp-auth.mjs
import process from "node:process";

const API = process.env.API ?? "http://127.0.0.1:8787";
const KC = process.env.KC ?? "http://localhost:8081/realms/assay";
const INTERNAL = process.env.ASSAY_INTERNAL_TOKEN ?? "mcp-secret";
const SDK = `${process.cwd()}/apps/api/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StreamableHTTPClientTransport } = await import(`${SDK}/client/streamableHttp.js`);

const txt = (r) => r?.content?.[0]?.text ?? "";
const fails = [];

async function ropc(user, pass) {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "assay-mcp",
    username: user,
    password: pass,
    scope: "openid",
  });
  const r = await fetch(`${KC}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`ROPC ${user}: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "assay-live", version: "0" });
  await client.connect(transport);
  return { client, transport };
}

// 1) discovery — protected resource metadata points at Keycloak
const meta = await (await fetch(`${API}/.well-known/oauth-protected-resource`)).json();
console.log("PRM:", meta.resource, "| AS:", JSON.stringify(meta.authorization_servers));
if (!String(meta.resource).endsWith("/mcp")) fails.push("PRM.resource");
if (!(meta.authorization_servers ?? []).some((a) => a.includes("/realms/assay")))
  fails.push("PRM.authorization_servers");

// 2) unauthenticated → 401 + WWW-Authenticate(resource_metadata)
const un = await fetch(`${API}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
const wa = un.headers.get("www-authenticate") ?? "";
console.log("no-token POST /mcp →", un.status, "| WWW-Authenticate:", wa);
if (un.status !== 401 || !wa.includes("resource_metadata")) fails.push("401-challenge");

// 3) alice (member) over OIDC — full MCP session + role gating
{
  const { client, transport } = await connect(await ropc("alice", "alice"));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  console.log("[alice/member] tools:", tools.join(","));
  if (tools.length !== 5) fails.push("alice.tools");
  const lr = await client.callTool({ name: "list_runs", arguments: {} });
  if (lr.isError) fails.push("alice.list_runs");
  const sr = await client.callTool({ name: "submit_run", arguments: { harness_id: "scripted", task: "mcp e2e" } });
  console.log("[alice] submit_run isError:", !!sr.isError, "|", txt(sr).slice(0, 50).replace(/\n/g, " "));
  if (sr.isError) fails.push("alice.submit_run");
  const rh = await client.callTool({ name: "register_harness", arguments: { spec: "{}" } });
  console.log("[alice] register_harness isError:", !!rh.isError, "|", txt(rh));
  if (!rh.isError || !txt(rh).includes("FORBIDDEN")) fails.push("alice.register should be FORBIDDEN");
  await transport.close();
}

// 4) carol (admin) — register_harness allowed
{
  const { client, transport } = await connect(await ropc("carol", "carol"));
  const HARNESS = JSON.stringify({
    kind: "service",
    id: "mcpbu",
    version: "1.0.0",
    services: [{ name: "agent-server", image: "img", port: 8080, needs: [], perRun: [], replicas: 1 }],
    dependencies: [],
    frontDoor: { service: "agent-server", submit: "POST /runs" },
    traceSource: { kind: "mlflow", endpoint: "http://m:5000" },
  });
  const rh = await client.callTool({ name: "register_harness", arguments: { spec: HARNESS } });
  console.log("[carol/admin] register_harness isError:", !!rh.isError, "|", txt(rh).replace(/\n/g, " "));
  if (rh.isError) fails.push("carol.register_harness should succeed");
  await transport.close();
}

// 5) API-key (ak_) Bearer also authenticates the MCP endpoint
{
  const issued = await (
    await fetch(`${API}/internal/tenant-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": INTERNAL },
      body: JSON.stringify({ workspace: "acme" }),
    })
  ).json();
  if (!issued.apiKey) fails.push("apikey.issue");
  else {
    const { client, transport } = await connect(issued.apiKey);
    const tools = (await client.listTools()).tools;
    console.log("[api-key/admin] tools:", tools.length);
    if (tools.length !== 5) fails.push("apikey.tools");
    await transport.close();
  }
}

if (fails.length) {
  console.log("\nFAIL:", fails);
  process.exit(1);
}
console.log("\nALL MCP AUTH CHECKS PASSED");
