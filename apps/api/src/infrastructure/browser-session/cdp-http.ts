import { request } from "undici";

// ── CHROME ANSWERS A HOST HEADER, NOT A URL ──────────────────────────────────────────────────────────
//
// Chrome's DevTools HTTP endpoints REFUSE any `Host` that is not an IP literal or `localhost`:
//
//   500 Host header is specified and is not an IP address or localhost
//
// which is a deliberate DNS-rebinding defence, not a bug. `http://browser:9222` — the compose service name
// this deployment recommends, ships as the default, and documents — therefore can never answer, while the
// container's IP returns 200 for the same request. The pool's readiness poll only accepted `res.ok`, so the
// 500 was polled to exhaustion and reported as "the browser did not become reachable": a refusal reported as
// silence, sending the operator to look at the browser instead of the header.
//
// So the name is kept for DNS and for the proxy decision, and only the HEADER is corrected. That ordering is
// the point: with `HTTP_PROXY` set, the name form is NO_PROXY-bypassed but Chrome-rejected, while a
// pre-resolved IP form is Chrome-accepted but tunnelled to a proxy that cannot route a compose-internal
// address — both spellings break, for different reasons. Overriding the header sidesteps both.
//
// NOT `fetch`: `host` is a forbidden header name there, silently dropped, and the request still gets the 500
// (verified). undici's `request` sends what it is given, and rides the same global dispatcher — so the proxy
// and NO_PROXY decisions this deployment configured still apply.
export const cdpFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  return request(url, {
    method: method as "GET" | "PUT" | "POST" | "DELETE",
    headers: { host: "localhost" },
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
  }).then(async (res) => {
    const text = await res.body.text();
    return new Response(text, { status: res.statusCode });
  });
};
