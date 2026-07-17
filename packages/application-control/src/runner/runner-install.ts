// The `curl … | sh` bootstrap for a headless host that has NEITHER everdict NOR node: the control plane serves
// `GET /install.sh?token=…`, which renders `renderRunnerInstallScript` — it downloads the standalone `everdict-runner`
// binary (built by the cli-release workflow, S2) matching the host's OS/arch and installs + pairs in one paste.
// `renderRunnerInstallCommand` is the one-liner the register dialog shows. Design: docs/architecture/runner-distribution.md.

// A pairing token is `rnr_` + base64url (A–Z a–z 0–9 _ -). Reject anything else BEFORE embedding it in a served shell
// script or a URL — a token is the only untrusted value here, so this closes shell/URL injection at the boundary.
const RUNNER_TOKEN_RE = /^rnr_[A-Za-z0-9_-]+$/;
export function isRunnerToken(token: string): boolean {
  return RUNNER_TOKEN_RE.test(token);
}

// The paste-once one-liner: `curl -fsSL "<cp>/install.sh?token=rnr_…" | sh`. apiUrl is the control-plane base the runner
// will also connect to (the install script bakes it into `--api-url`). The token rides in the query — the same one-time
// secret the raw attach command already exposes.
export function renderRunnerInstallCommand(input: { token: string; apiUrl: string }): string {
  const base = input.apiUrl.replace(/\/$/, "");
  return `curl -fsSL "${base}/install.sh?token=${input.token}" | sh`;
}

// The served installer. Interpolated values: token (validated `rnr_…`), apiUrl (the control-plane base, server-derived),
// releaseRepo ("owner/name" of the GitHub repo whose latest release holds the everdict-runner-* assets). All three are
// server-controlled or boundary-validated, and every use is double-quoted, so the emitted script has no injection seam.
export function renderRunnerInstallScript(input: { token: string; apiUrl: string; releaseRepo: string }): string {
  const api = input.apiUrl.replace(/\/$/, "");
  return `#!/bin/sh
# Everdict self-hosted runner installer — downloads the standalone everdict-runner binary and pairs this machine.
# It carries a pairing token (shown once); do not share it. Re-run to re-pair. Design: everdict runner distribution.
set -eu

REPO="${input.releaseRepo}"
API_URL="${api}"
TOKEN="${input.token}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) os_tag=linux ;;
  Darwin) os_tag=darwin ;;
  *) echo "✗ Unsupported OS: $os. On Windows, download everdict-runner-win-x64.exe from the release and run it with --pair." >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch_tag=x64 ;;
  arm64|aarch64) arch_tag=arm64 ;;
  *) echo "✗ Unsupported architecture: $arch." >&2; exit 1 ;;
esac
asset="everdict-runner-\${os_tag}-\${arch_tag}"
url="https://github.com/\${REPO}/releases/latest/download/\${asset}"

# Install to a directory on PATH — prefer /usr/local/bin, fall back to ~/.local/bin when it is not writable.
bindir="/usr/local/bin"
[ -w "$bindir" ] || bindir="$HOME/.local/bin"
mkdir -p "$bindir"
dest="$bindir/everdict-runner"

echo "Downloading $asset …"
if ! curl -fSL -o "$dest" "$url"; then
  echo "✗ No prebuilt binary for \${os_tag}-\${arch_tag} at $url." >&2
  exit 1
fi
chmod +x "$dest"

# Persistence: a systemd service (survives reboot/logout) when systemd is present and we are root; otherwise run in the
# foreground so the paste still pairs the machine (print the service snippet for later).
if command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
  cat > /etc/systemd/system/everdict-runner.service <<UNIT
[Unit]
Description=Everdict self-hosted runner
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=$dest --pair "$TOKEN" --api-url "$API_URL"
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now everdict-runner
  echo "✓ Installed everdict-runner as a systemd service (systemctl status everdict-runner)."
else
  echo "✓ Installed everdict-runner at $dest."
  echo "  Running in the foreground (Ctrl-C to stop). To keep it running after logout, re-run this installer as root on a systemd host."
  exec "$dest" --pair "$TOKEN" --api-url "$API_URL"
fi
`;
}
