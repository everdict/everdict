// The headless-browser image for the per-case eval browser (topology docker/nomad/k8s runtimes) + the interactive
// session / cookie-capture browser (browser-profiles S1/S3/S6). `chromedp/headless-shell` is a THIRD-PARTY public
// image (the chromedp project on Docker Hub) — a minimal headless Chromium + socat exposing CDP on 9222. Everdict
// does not build it; it is a runtime dependency, pulled by whatever daemon/cluster runs the browser.
//
// PINNED BY DIGEST (infra rule: ban `:latest`, reproducible at pull time). This digest is
// `chromedp/headless-shell:latest`'s multi-arch (linux/amd64 + arm64) manifest index as of 2026-07-17. To bump:
// re-resolve `docker buildx imagetools inspect chromedp/headless-shell:latest`, update the digest here, then re-run
// the mirror workflow (.github/workflows/browser-image.yml).
//
// OVERRIDABLE per deployment: `EVERDICT_BROWSER_IMAGE` (the interactive session provisioner) /
// `RuntimeSpec.browserImage` (the per-case eval browser) — point managed/air-gapped deployments at the GHCR mirror
// (`ghcr.io/everdict/headless-shell`) or a workspace BYO registry to drop the Docker Hub dependency.
export const DEFAULT_BROWSER_IMAGE =
  "chromedp/headless-shell@sha256:7f8ec4782f1b138c30900e65ae53795d5966fbf52168b8fc062843db3e6d5be5";
