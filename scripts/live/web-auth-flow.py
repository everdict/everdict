#!/usr/bin/env python3
"""Headless OAuth through apps/web → proves the web forwards a real Keycloak token to the control plane.

Drives the Auth.js + Keycloak authorization-code flow with a cookie jar (no browser), then fetches
the workspace-scoped pages (Linear-style /{workspace}/...) and asserts workspace + role-gated UI
come from the control-plane GET /me.
"""
import os
import re
import sys
import requests
from bs4 import BeautifulSoup

WEB = os.environ.get("WEB", "http://localhost:3001")
WS = os.environ.get("WS", "acme")  # workspace from the test fixture (slug = first URL segment)
USERS = {"alice": ("alice", "member"), "carol": ("carol", "admin")}

# The ko-locale strings the two gated pages ACTUALLY render (apps/web/messages/ko.json) — the page header,
# which proves the page rendered at all, and the refusal the role gate shows. Asserted as PRODUCT OUTPUT, so
# the locale is pinned below rather than left to Accept-Language.
# (asserts ko-locale UI output — KEEP)
RUNS_NEW = ("새 실행", "실행을 시작할 권한이 없어요.")  # runsPage.newRun / runsPage.noPermissionTitle
HARNESSES_NEW = ("하니스 등록", "하니스를 등록할 권한이 없어요.")  # harnessesPage.registerTitle / .noPermTitle
LOCALE_COOKIE = "everdict-locale"  # shared/i18n/config.ts — an explicit choice beats Accept-Language


def login(username, password):
    s = requests.Session()
    # Pin the locale. Without it the app falls back to `en` for a header-less client, so every assertion on
    # ko output below would have been reading a page that never contained Korean at all.
    s.cookies.set(LOCALE_COOKIE, "ko")
    # 1) Auth.js CSRF (sets cookie + returns token)
    csrf = s.get(f"{WEB}/api/auth/csrf", timeout=10).json()["csrfToken"]
    # 2) POST signin/keycloak → follow redirect chain to the Keycloak login form
    r = s.post(
        f"{WEB}/api/auth/signin/keycloak",
        data={"csrfToken": csrf, "callbackUrl": f"{WEB}/{WS}"},
        timeout=15,
    )
    # Keycloak 26 sets auth-session cookies SameSite=None; Secure — requests won't send Secure cookies
    # over plain HTTP (localhost dev). Drop the flag so the login POST carries the session cookies.
    for c in s.cookies:
        c.secure = False
    soup = BeautifulSoup(r.text, "html.parser")
    form = soup.find("form", id="kc-form-login")
    if form is None:
        form = next((f for f in soup.find_all("form") if "authenticate" in (f.get("action") or "")), None)
    if form is None or not form.get("action"):
        raise RuntimeError(f"no Keycloak login form (status {r.status_code}, url {r.url})")
    # 3) submit credentials → 302 to the web callback (?code=...)
    r = s.post(form["action"], data={"username": username, "password": password}, allow_redirects=False, timeout=15)
    cb = r.headers.get("location")
    if not cb or "/api/auth/callback/keycloak" not in cb:
        raise RuntimeError(
            f"login did not redirect to callback (status {r.status_code}, loc {cb})\n"
            f"action={form['action']}\nbody={BeautifulSoup(r.text, 'html.parser').get_text(' ', strip=True)[:400]}"
        )
    # 4) follow the callback → Auth.js exchanges the code, sets the session cookie, lands on /{workspace}
    s.get(cb, timeout=15)
    return s


def get(s, path):
    r = s.get(f"{WEB}{path}", timeout=15)
    return r.status_code, r.text


def gate(page, code, body, markers, failures, who, want_form):
    """Read a role-gated page: it must have RENDERED (200 + its own header), and then either show the form
    or the refusal. The absence of a refusal string is not evidence of a form — a 500, a redirect to the
    login screen and an `en` render all contain no refusal either, and each one used to read as "allowed"."""
    header, refusal = markers
    if code != 200 or header not in body:
        failures.append(f"{who}: {page} did not render (HTTP {code}, header {header!r} absent)")
        return
    form = refusal not in body
    print(f"           {page} form:{form} (want {want_form})")
    if form != want_form:
        failures.append(f"{who}: {page} gate wrong (form={form}, want {want_form})")


def main():
    failures = []
    for username, (password, role) in USERS.items():
        s = login(username, password)
        code, body = get(s, f"/{WS}")
        ok_ws = code == 200 and WS in body  # workspace from GET /me (server-side token read works)
        print(f"[{username}/{role}] GET /{WS} → {code}  workspace={WS}:{ok_ws}")
        if not ok_ws:
            failures.append(f"{username}: workspace page missing workspace (code {code})")

        # BFF hardening: the client-visible session must NOT carry the access token (no JWT leak).
        # An endpoint that errored carries no token either, and Auth.js answers `{}` when nobody is signed in —
        # so the session must first BE one. A 200 carrying a `user` is what makes "no accessToken in it" a
        # claim about the BFF rather than about an empty body.
        sc, sess = get(s, "/api/auth/session")
        if sc != 200 or '"user"' not in sess:
            failures.append(f"{username}: /api/auth/session is not a signed-in session (HTTP {sc}, body {sess[:80]!r})")
        leaked = ("accessToken" in sess) or ("eyJ" in sess)
        print(f"           /api/auth/session token-leak:{leaked} (want False)")
        if leaked:
            failures.append(f"{username}: access token leaked to client session")

        # role-gated UI (mirrors the control-plane authz matrix, driven by /me roles).
        # harnesses:register has no role gate (viewer+ in packages/domain/src/auth/authz.ts), so a member gets the form too.
        rc, rbody = get(s, f"/{WS}/runs/new")
        gate("runs/new", rc, rbody, RUNS_NEW, failures, username, want_form=True)
        hc, hbody = get(s, f"/{WS}/harnesses/new")
        gate("harnesses/new", hc, hbody, HARNESSES_NEW, failures, username, want_form=True)

    if failures:
        print("\nFAIL:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("\nALL WEB AUTH+AUTHZ CHECKS PASSED")


if __name__ == "__main__":
    main()
