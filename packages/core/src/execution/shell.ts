// Safe shell-argument quoting — use when embedding a user task/path into a shell command.
export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
