// The names a resolved tool wears in front of the MODEL. A store capability has a name its author chose; what the
// model calls is a NAMESPACED name, so two MCP servers (or a server and a built-in) cannot fight over one name.
// These two builders are the only place that namespacing is spelled: the agent runtime bridges with them, and the
// Settings › Agent › Tools detail explains the tool with them. Keeping one spelling is the point — a member reading
// "what will the model call" must read the same string the runtime registers.

// `mcp__<server>__<tool>` — the server segment is sanitized because a capability/server name may contain characters a
// tool name may not (the provider tool-name grammar is `[a-zA-Z0-9_-]`).
export function mcpBridgedName(serverName: string, toolName: string): string {
  return `${mcpBridgePrefix(serverName)}${toolName}`;
}

export function mcpBridgePrefix(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_]/g, "_")}__`;
}

// `code__<name>` — a code capability is exactly one function, so its bridged name is its own.
export function codeBridgedName(toolName: string): string {
  return `code__${toolName}`;
}
