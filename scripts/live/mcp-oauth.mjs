// Live verify the MCP "login like Linear" OAuth path end-to-end — exactly what Claude Code /
// mcp-remote do, with the browser steps (login + consent) scripted against real Keycloak.
// DCR -> PKCE auth-code -> Keycloak login -> consent -> code -> token -> /mcp (initialize + tools/list).
// Needs anonymous DCR enabled (deploy/keycloak/enable-mcp-dcr.sh). Run from repo root:
//   API=http://127.0.0.1:8787 KC_USER=alice KC_PASS=alice node scripts/live/mcp-oauth.mjs
import crypto from "node:crypto";

const API = process.env.API ?? "http://127.0.0.1:8787";
const USER = process.env.KC_USER ?? "alice";
const PASS = process.env.KC_PASS ?? "alice";
const REDIRECT = "http://localhost:9876/callback"; // loopback (trusted-hosts)
const b64url = (b) => Buffer.from(b).toString("base64url");
const log = (...a) => console.log(...a);
let step = 0;
const ok = (m) => log(`  ✓ [${++step}] ${m}`);
const die = (m) => { log(`  ✗ ${m}`); process.exit(1); };

// cookie jar
const jar = new Map();
const absorb = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
};
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const abs = (u) => new URL(u, AS).href; // resolve relative Keycloak form actions / redirects
const formAction = (html) => { const m = html.match(/<form[^>]*\saction="([^"]+)"/i)?.[1]?.replace(/&amp;/g, "&"); return m ? abs(m) : undefined; };

// 1) protected-resource → authorization server
const prm = await (await fetch(`${API}/.well-known/oauth-protected-resource`)).json();
const AS = prm.authorization_servers?.[0];
if (!AS) die("no authorization_servers in PRM");
ok(`PRM: resource=${prm.resource} · AS=${AS}`);

// 2) AS metadata (OIDC discovery)
const asMeta = await (await fetch(`${AS}/.well-known/openid-configuration`)).json();
const { authorization_endpoint, token_endpoint, registration_endpoint } = asMeta;
if (!authorization_endpoint || !token_endpoint || !registration_endpoint) die("AS metadata incomplete");
ok("AS metadata: authorization/token/registration endpoints present");

// 3) Dynamic Client Registration (anonymous, loopback redirect, public PKCE)
const reg = await fetch(registration_endpoint, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "mcp-oauth-verify", redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
});
if (reg.status !== 201) die(`DCR failed: HTTP ${reg.status} ${await reg.text()}`);
const client = await reg.json();
const clientId = client.client_id;
ok(`DCR: registered public client ${clientId}`);

// 4) PKCE
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
const state = b64url(crypto.randomBytes(8));

// 5) Authorization request → Keycloak login page
const authUrl = `${authorization_endpoint}?${new URLSearchParams({
  client_id: clientId, response_type: "code", redirect_uri: REDIRECT,
  scope: "openid profile", state, code_challenge: challenge, code_challenge_method: "S256" })}`;
let res = await fetch(authUrl, { redirect: "manual" });
absorb(res);
let html = await res.text();
let action = formAction(html);
if (!action) die(`no login form in authorization response (HTTP ${res.status})`);
ok(`authorization_endpoint → login page (HTTP ${res.status})`);

// 6) Submit login form, then follow Keycloak steps (consent / required-action) until the loopback ?code
res = await fetch(action, { method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
  body: new URLSearchParams({ username: USER, password: PASS, credentialId: "" }) });
absorb(res);
ok(`login (${USER}) submitted`);

let code, hops = 0;
while (hops++ < 6) {
  const loc = res.headers.get("location");
  if (loc) {
    if (loc.startsWith(REDIRECT)) { code = new URL(loc).searchParams.get("code"); break; }
    res = await fetch(abs(loc), { redirect: "manual", headers: { cookie: cookieHeader() } }); // GET next KC page
    absorb(res);
    continue;
  }
  // a page with a form → likely the consent grant; submit "accept"
  html = await res.text();
  action = formAction(html);
  if (!action) die(`stuck: no redirect and no form (HTTP ${res.status})`);
  const consent = /OAUTH_GRANT|consent|동의|grant/i.test(html);
  res = await fetch(action, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
    body: new URLSearchParams({ accept: "Yes" }) });
  absorb(res);
  if (consent) ok("consent screen → granted (Yes)");
}
if (!code) die("did not reach loopback redirect with ?code");
ok("→ loopback redirect with ?code (browser steps complete)");

// 7) Token exchange (code + PKCE verifier)
const tok = await fetch(token_endpoint, { method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }) });
const tokJson = await tok.json();
if (!tokJson.access_token) die(`token exchange failed: ${JSON.stringify(tokJson)}`);
ok("token exchange → access_token (OAuth complete)");

// 8) Use the OAuth token on /mcp
const accept = "application/json, text/event-stream";
const H = (sid) => ({ authorization: `Bearer ${tokJson.access_token}`, "content-type": "application/json", accept, ...(sid ? { "mcp-session-id": sid } : {}) });
const init = await fetch(`${API}/mcp`, { method: "POST", headers: H(),
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "0" } } }) });
if (init.status !== 200) die(`/mcp initialize → HTTP ${init.status}`);
const sid = init.headers.get("mcp-session-id");
await fetch(`${API}/mcp`, { method: "POST", headers: H(sid), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
const listRaw = await (await fetch(`${API}/mcp`, { method: "POST", headers: H(sid),
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) })).text();
const data = JSON.parse(listRaw.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}");
const tools = (data.result?.tools ?? []).map((t) => t.name);
ok(`/mcp initialize 200 (session ${sid?.slice(0, 8)}…) · tools/list → ${tools.length} tools · diff_datasets=${tools.includes("diff_datasets")}`);

if (client.registration_access_token && client.registration_client_uri)
  await fetch(client.registration_client_uri, { method: "DELETE", headers: { authorization: `Bearer ${client.registration_access_token}` } });
log("\n✅ OAuth 'login like Linear' verified end-to-end (DCR → PKCE auth-code → login → consent → token → /mcp).");
