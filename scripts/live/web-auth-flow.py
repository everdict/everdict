#!/usr/bin/env python3
"""Headless OAuth through apps/web → proves the web forwards a real Keycloak token to the control plane.

Drives the Auth.js + Keycloak authorization-code flow with a cookie jar (no browser), then fetches
dashboard pages and asserts workspace + role-gated UI come from the control-plane GET /me.
"""
import os
import re
import sys
import requests
from bs4 import BeautifulSoup

WEB = os.environ.get("WEB", "http://localhost:3001")
USERS = {"alice": ("alice", "member"), "carol": ("carol", "admin")}


def login(username, password):
    s = requests.Session()
    # 1) Auth.js CSRF (sets cookie + returns token)
    csrf = s.get(f"{WEB}/api/auth/csrf", timeout=10).json()["csrfToken"]
    # 2) POST signin/keycloak → follow redirect chain to the Keycloak login form
    r = s.post(
        f"{WEB}/api/auth/signin/keycloak",
        data={"csrfToken": csrf, "callbackUrl": f"{WEB}/dashboard"},
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
    # 4) follow the callback → Auth.js exchanges the code, sets the session cookie, lands on /dashboard
    s.get(cb, timeout=15)
    return s


def get(s, path):
    r = s.get(f"{WEB}{path}", timeout=15)
    return r.status_code, r.text


def main():
    failures = []
    for username, (password, role) in USERS.items():
        s = login(username, password)
        code, body = get(s, "/dashboard")
        ok_ws = code == 200 and "acme" in body  # workspace from GET /me (server-side token read works)
        print(f"[{username}/{role}] GET /dashboard → {code}  workspace=acme:{ok_ws}")
        if not ok_ws:
            failures.append(f"{username}: dashboard missing workspace (code {code})")

        # BFF hardening: the client-visible session must NOT carry the access token (no JWT leak).
        _, sess = get(s, "/api/auth/session")
        leaked = ("accessToken" in sess) or ("eyJ" in sess)
        print(f"           /api/auth/session token-leak:{leaked} (want False)")
        if leaked:
            failures.append(f"{username}: access token leaked to client session")

        # role-gated UI (mirrors the control-plane authz matrix, driven by /me roles)
        rc, rbody = get(s, "/dashboard/runs/new")
        run_form = "권한이 없습니다" not in rbody  # member+ may submit
        hc, hbody = get(s, "/dashboard/harnesses/new")
        harness_form = "권한이 없습니다" not in hbody  # admin only

        want_harness = role == "admin"
        print(f"           runs/new form:{run_form} (want True)   harnesses/new form:{harness_form} (want {want_harness})")
        if not run_form:
            failures.append(f"{username}: runs/new should allow submit")
        if harness_form != want_harness:
            failures.append(f"{username}: harnesses/new gate wrong (got {harness_form}, want {want_harness})")

    if failures:
        print("\nFAIL:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("\nALL WEB AUTH+AUTHZ CHECKS PASSED")


if __name__ == "__main__":
    main()
