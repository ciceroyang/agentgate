/**
 * Read the MCP server lists this machine already has.
 *
 * The property this keeps: a list that is missing something is not printed as a complete list.
 * A config file that exists but cannot be read or parsed stays in the output with a reason, and
 * the caller turns that into an "incomplete" exit code. Silently skipping it would produce
 * exactly the artefact this project exists to argue against - a clean-looking list that nobody
 * can tell is partial.
 *
 * Nothing here reads env or headers, and nothing prints an argument: those are where the
 * credentials live. A remote address is reduced to its host, because paths and query strings
 * routinely carry tokens.
 */
import { candidateSources } from "./known-configs.mjs"
import { parseCodexMcpToml } from "./codex-toml.mjs"

export const SCHEMA_VERSION = 1

const NPM_NAME = /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/i
const NPM_SPEC = /^((?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*)@([0-9][0-9A-Za-z.+-]*)$/
const PYPI_SPEC = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][0-9A-Za-z.+-]*)$/
const JUMP = ["dlx", "exec", "run", "x", "-y", "--yes", "--node-options"]
const JS_RUNNERS = ["npx", "bunx", "pnpx", "pnpm", "yarn"]
const PY_RUNNERS = ["uvx", "pipx", "uv"]

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function runnerOf(command) {
  return String(command || "").split(/[\\/]/).pop()
}

/**
 * The package a configured command would install, if it names one.
 *
 * Only the package name and an exact version are kept. The rest of the arguments are dropped on
 * purpose: "npx -y @scope/thing --token=..." should yield the package and nothing else.
 */
export function packageOf(command, args) {
  const runner = runnerOf(command)
  const list = Array.isArray(args) ? args.filter(function (a) { return typeof a === "string" }) : []
  if (runner === "node" || runner === "python" || runner === "python3" || runner === "deno") return null
  const jsRunner = JS_RUNNERS.indexOf(runner) !== -1
  const pyRunner = PY_RUNNERS.indexOf(runner) !== -1
  if (!jsRunner && !pyRunner) return null
  for (const arg of list) {
    if (arg.charAt(0) === "-") continue
    if (JUMP.indexOf(arg) !== -1) continue
    if (jsRunner) {
      const pinned = NPM_SPEC.exec(arg)
      if (pinned) return { registry: "npm", package: pinned[1], version: pinned[2] }
      if (NPM_NAME.test(arg)) return { registry: "npm", package: arg, version: null }
    }
    if (pyRunner) {
      const pinned = PYPI_SPEC.exec(arg)
      if (pinned) return { registry: "pypi", package: pinned[1], version: pinned[2] }
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(arg)) return { registry: "pypi", package: arg, version: null }
    }
    // The first positional argument is the thing being run; later ones are its arguments.
    break
  }
  return null
}

export function urlOf(entry) {
  for (const key of ["url", "serverUrl", "httpUrl", "endpoint"]) {
    if (typeof entry[key] === "string" && entry[key]) return entry[key]
  }
  return null
}

export function hostOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.host || null
  } catch (error) {
    // A host that cannot be parsed is not a host we will print.
    return null
  }
}

export function transportOf(entry) {
  const declared = entry.type || entry.transport
  if (typeof declared === "string" && declared.trim()) return declared.trim().toLowerCase()
  const url = urlOf(entry)
  if (url) return /^wss?:/i.test(url) ? "ws" : "http"
  if (typeof entry.command === "string" && entry.command.trim()) return "stdio"
  return "unknown"
}

function entriesFromMap(map, projectPath) {
  const out = []
  if (Array.isArray(map)) {
    for (const item of map) {
      if (typeof item === "string" && item.trim()) out.push({ name: item.trim(), entry: {}, projectPath: projectPath || null })
      else if (isObject(item) && typeof item.name === "string" && item.name.trim()) out.push({ name: item.name.trim(), entry: item, projectPath: projectPath || null })
    }
    return out
  }
  if (!isObject(map)) return out
  for (const name of Object.keys(map)) {
    const entry = map[name]
    out.push({ name: name, entry: isObject(entry) ? entry : {}, projectPath: projectPath || null })
  }
  return out
}

/** Which part of a document holds servers, for the shapes in known-configs.mjs. */
export function serversIn(doc, shape) {
  const out = []
  if (!isObject(doc)) return out
  if (shape === "claude-projects") {
    if (!isObject(doc.projects)) return out
    for (const projectPath of Object.keys(doc.projects)) {
      const project = doc.projects[projectPath]
      if (!isObject(project)) continue
      for (const item of entriesFromMap(project.mcpServers, projectPath)) out.push(item)
    }
    return out
  }
  for (const item of entriesFromMap(doc[shape], null)) out.push(item)
  return out
}

function recordOf(item, source) {
  const entry = item.entry || {}
  const pkg = packageOf(entry.command, entry.args)
  const url = urlOf(entry)
  const host = url ? hostOf(url) : null
  return {
    name: item.name,
    enabled: entry.enabled === false ? false : entry.enabled === true ? true : null,
    transport: transportOf(entry),
    package: pkg ? pkg.package : null,
    version: pkg ? pkg.version : null,
    registry: pkg ? pkg.registry : null,
    host,
    identityStatus: pkg ? (pkg.version ? "declared-package-version" : "declared-package") : host ? "remote-host-only" : "unresolved",
    tool: source.tool,
    scope: source.scope,
    source: source.abs,
    projectPath: item.projectPath,
  }
}

/**
 * options: { home, roots, platform, readFile, exists, now }
 * readFile throws when a file cannot be read; exists answers whether a candidate is there.
 */
export function discover(options) {
  const readFile = options.readFile
  const exists = options.exists
  const sources = []
  const records = []
  for (const candidate of candidateSources(options)) {
    if (!exists(candidate.abs)) continue
    let text
    try {
      text = readFile(candidate.abs)
    } catch (error) {
      sources.push(Object.assign({}, candidate, { status: "unreadable", reason: "read-failed", servers: 0 }))
      continue
    }
    let items
    try {
      items = candidate.parser === "toml" ? parseCodexMcpToml(text) : serversIn(JSON.parse(text), candidate.shape)
    } catch (error) {
      const reason = candidate.parser === "toml" ? (error.code === "unsupported-mcp-toml" ? "unsupported-mcp-toml" : "invalid-toml") : "invalid-json"
      sources.push(Object.assign({}, candidate, { status: "unparsed", reason, servers: 0 }))
      continue
    }
    sources.push(Object.assign({}, candidate, { status: "read", reason: null, servers: items.length }))
    for (const item of items) records.push(recordOf(item, candidate))
  }
  const identityOf = r => JSON.stringify([r.registry, r.package, r.version, r.transport, r.enabled,
    r.package ? null : [r.name, r.host, r.source, r.projectPath]])
  const byName = new Map()
  for (const record of records) {
    const key = identityOf(record)
    const existing = byName.get(key)
    if (existing) {
      if (existing.from.indexOf(record.source) === -1) existing.from.push(record.source)
    } else {
      byName.set(key, { name: record.name, enabled: record.enabled, transport: record.transport, package: record.package, version: record.version, registry: record.registry, host: record.host, identityStatus: record.identityStatus, from: [record.source], scopes: [record.scope], tools: [record.tool] })
    }
  }
  const servers = Array.from(byName.values()).sort(function (a, b) { return a.name.localeCompare(b.name) })
  for (const record of records) {
    const merged = byName.get(identityOf(record))
    if (merged.scopes.indexOf(record.scope) === -1) merged.scopes.push(record.scope)
    if (merged.tools.indexOf(record.tool) === -1) merged.tools.push(record.tool)
  }
  const aliases = new Map()
  for (const record of records) {
    if (!aliases.has(record.name)) aliases.set(record.name, new Set())
    aliases.get(record.name).add(identityOf(record))
  }
  const conflicts = [...aliases].filter(([, identities]) => identities.size > 1).map(([name]) => name)
  const incomplete = sources.some(function (s) { return s.status !== "read" }) || conflicts.length > 0
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: options.now || new Date().toISOString(),
    home: options.home || null,
    roots: options.roots || [],
    sources: sources.sort(function (a, b) { return a.abs.localeCompare(b.abs) }),
    records: records.sort(function (a, b) { return a.name.localeCompare(b.name) || a.source.localeCompare(b.source) }),
    servers: servers,
    conflicts,
    counts: {
      sourcesFound: sources.length,
      sourcesRead: sources.filter(function (s) { return s.status === "read" }).length,
      sourcesIncomplete: sources.filter(function (s) { return s.status !== "read" }).length,
      servers: servers.length,
      serversDisabled: servers.filter(function (s) { return s.enabled === false }).length,
      serversExported: servers.filter(function (s) { return s.enabled !== false }).length,
      exportedPackagesUnknown: servers.filter(function (s) { return s.enabled !== false && !s.package }).length,
      exportedVersionsUnknown: servers.filter(function (s) { return s.enabled !== false && !s.version }).length,
    },
    incomplete: incomplete,
    boundary: "只列出这些配置路径里能找到的服务器。找不到的路径不代表没有，读不到的文件已单独列出。",
  }
}

/** Inventory-ready text: lines for package coordinates, JSON for any alias-only entry. */
export function renderText(report) {
  const included = report.servers.filter(function (s) { return s.enabled !== false })
  // An alias such as "tool@1.2.3" would be reinterpreted by inventory's plain-text parser as
  // an npm package with an exact version. JSON preserves the explicit null package/version.
  if (included.some(function (s) { return !s.package })) return renderInventory(report) + "\n"
  return included.map(function (s) {
    return s.package ? (s.registry || "unknown") + ":" + s.package + (s.version ? "@" + s.version : "") : s.name
  }).join("\n") + (included.length ? "\n" : "")
}

/** Preserve package coordinates for inventory; source/conflict diagnostics stay in full JSON. */
export function renderInventory(report) {
  return JSON.stringify({ tools: report.servers.filter(s => s.enabled !== false).map(s => ({ name: s.name, package: s.package, registry: s.registry, version: s.version })) }, null, 2)
}
