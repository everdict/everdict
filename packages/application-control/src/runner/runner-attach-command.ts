// The single SSOT for the `everdict runner` attach command shown after pairing a HEADLESS runner (the workspace-shared
// runner dialog, headless personal pairing) and embedded verbatim in the GitHub Actions install script.
//
// The token is a POSITIONAL value of `--pair`, NOT a `--token` flag: the CLI reads `flags.get("pair")` and requires it
// to start with `rnr_`. Writing `--pair --token <rnr_…>` makes the flag parser treat `--pair` as a valueless boolean
// ("true") and drop the token, so the command errors out ("--pair <rnr_…> required"). Keeping the format here means the
// surfaces that print it (web dialog, install script) can never drift back into that broken shape.
export function renderRunnerAttachCommand(input: { token: string; apiUrl?: string }): string {
  const apiUrl = input.apiUrl?.replace(/\/$/, "");
  return `everdict runner --pair "${input.token}"${apiUrl ? ` --api-url "${apiUrl}"` : ""}`;
}
