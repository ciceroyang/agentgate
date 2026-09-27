/**
 * Where MCP clients keep the list of servers they run.
 *
 * One catalogue, because two lists drift: the guard already knows the repo-level config files
 * (packages/guard/src/checks/mcp-config.mjs) and discover also reads the machine. A path that
 * only one of them knows about is a server that is invisible in exactly the report that is
 * supposed to name it.
 *
 * "shape" is the part of the document that holds the servers, so what is supported is visible
 * as data instead of hidden in a parser branch. "parser" says how the file is read at all: a
 * TOML config is still listed and reported as unparsed rather than silently skipped.
 */
import { join } from "node:path"

/** Relative to a repository root. Mirrors CONFIG_PATHS in checks/mcp-config.mjs on purpose. */
export const PROJECT_SOURCES = [
  { path: ".mcp.json", tool: "mcp", shape: "mcpServers", parser: "json" },
  { path: "mcp.json", tool: "mcp", shape: "mcpServers", parser: "json" },
  { path: "claude_desktop_config.json", tool: "claude-desktop", shape: "mcpServers", parser: "json" },
  { path: ".cursor/mcp.json", tool: "cursor", shape: "mcpServers", parser: "json" },
  { path: ".vscode/mcp.json", tool: "vscode", shape: "servers", parser: "json" },
  { path: ".continue/config.json", tool: "continue", shape: "mcpServers", parser: "json" },
]

/** Relative to a home directory. platforms, when present, is the only place the path applies. */
export const MACHINE_SOURCES = [
  { path: ".cursor/mcp.json", tool: "cursor", shape: "mcpServers", parser: "json" },
  { path: ".codeium/windsurf/mcp_config.json", tool: "windsurf", shape: "mcpServers", parser: "json" },
  { path: ".continue/config.json", tool: "continue", shape: "mcpServers", parser: "json" },
  { path: ".claude.json", tool: "claude-code", shape: "claude-projects", parser: "json" },
  { path: ".gemini/settings.json", tool: "gemini", shape: "mcpServers", parser: "json" },
  { path: ".config/zed/settings.json", tool: "zed", shape: "context_servers", parser: "json" },
  { path: "Library/Application Support/Claude/claude_desktop_config.json", tool: "claude-desktop", shape: "mcpServers", parser: "json", platforms: ["darwin"] },
  { path: ".config/Claude/claude_desktop_config.json", tool: "claude-desktop", shape: "mcpServers", parser: "json", platforms: ["linux"] },
  // The bounded parser reads only MCP table fields; unsupported MCP shapes remain incomplete.
  { path: ".codex/config.toml", tool: "codex", shape: "mcp_servers", parser: "toml" },
]

/**
 * Every candidate path, with its scope resolved. Nothing here touches the filesystem: the
 * caller decides what exists and what can be read, which is what makes the parser testable.
 */
export function candidateSources(options) {
  const home = options.home
  const roots = options.roots || []
  const platform = options.platform || process.platform
  const out = []
  if (home) {
    for (const s of MACHINE_SOURCES) {
      if (s.platforms && s.platforms.indexOf(platform) === -1) continue
      out.push({ abs: join(home, s.path), scope: "machine", tool: s.tool, shape: s.shape, parser: s.parser })
    }
  }
  for (const root of roots) {
    for (const s of PROJECT_SOURCES) {
      out.push({ abs: join(root, s.path), scope: "project", tool: s.tool, shape: s.shape, parser: s.parser })
    }
  }
  return out
}
