/**
 * Read only Codex's MCP server tables from TOML. This is deliberately not a general TOML
 * document model: unrelated values (including env and headers) are never retained. If an MCP
 * table uses a shape we cannot interpret, the caller must report the source as incomplete.
 */

function invalid() {
  const error = new Error("invalid-toml")
  error.code = "invalid-toml"
  return error
}

function unsupported() {
  const error = new Error("unsupported-mcp-toml")
  error.code = "unsupported-mcp-toml"
  return error
}

/** Split logical statements without mistaking comments or multiline values for table headers. */
function statementsOf(text) {
  if (typeof text !== "string") throw invalid()
  const statements = []
  let current = ""
  let quote = null
  let triple = false
  let escaped = false
  let comment = false
  let square = 0
  let curly = 0
  const flush = () => {
    const statement = current.trim()
    if (statement) statements.push(statement)
    current = ""
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (comment) {
      if (c === "\n") {
        comment = false
        if (square === 0 && curly === 0) flush()
        else current += "\n"
      }
      continue
    }
    if (quote) {
      current += c
      if (escaped) { escaped = false; continue }
      if (quote === '"' && c === "\\") { escaped = true; continue }
      if (c === quote) {
        if (!triple) quote = null
        else if (text.slice(i, i + 3) === quote.repeat(3)) {
          current += quote.repeat(2)
          i += 2
          quote = null
          triple = false
        }
      }
      if (c === "\n" && quote && !triple) throw invalid()
      continue
    }
    if (c === "#") { comment = true; continue }
    if (c === '"' || c === "'") {
      quote = c
      triple = text.slice(i, i + 3) === c.repeat(3)
      current += triple ? c.repeat(3) : c
      if (triple) i += 2
      continue
    }
    if (c === "[") square++
    else if (c === "]") { square--; if (square < 0) throw invalid() }
    else if (c === "{") curly++
    else if (c === "}") { curly--; if (curly < 0) throw invalid() }
    if (c === "\n" && square === 0 && curly === 0) flush()
    else current += c
  }
  if (quote || square !== 0 || curly !== 0) throw invalid()
  flush()
  return statements
}

function stringAt(text, start) {
  const q = text[start]
  if (q !== '"' && q !== "'") throw invalid()
  const triple = text.slice(start, start + 3) === q.repeat(3)
  let i = start + (triple ? 3 : 1)
  if (triple && text[i] === "\n") i++
  let value = ""
  while (i < text.length) {
    if (triple && text.slice(i, i + 3) === q.repeat(3)) return { value, end: i + 3 }
    const c = text[i]
    if (!triple && c === q) return { value, end: i + 1 }
    if (!triple && (c === "\n" || c === "\r")) throw invalid()
    if (q === '"' && c === "\\") {
      const next = text[++i]
      if (next === undefined) throw invalid()
      if (triple && (next === "\n" || next === "\r")) {
        while (i < text.length && /\s/.test(text[i])) i++
        continue
      }
      const escapes = { '"': '"', "\\": "\\", b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" }
      if (Object.hasOwn(escapes, next)) value += escapes[next]
      else if (next === "u" || next === "U") {
        const digits = next === "u" ? 4 : 8
        const hex = text.slice(i + 1, i + 1 + digits)
        if (!new RegExp("^[0-9A-Fa-f]{" + digits + "}$").test(hex)) throw invalid()
        const point = parseInt(hex, 16)
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw invalid()
        value += String.fromCodePoint(point)
        i += digits
      } else throw invalid()
    } else value += c
    i++
  }
  throw invalid()
}

function keyPath(raw) {
  const path = []
  let i = 0
  while (i < raw.length) {
    while (/\s/.test(raw[i] || "")) i++
    if (i >= raw.length) throw invalid()
    if (raw[i] === '"' || raw[i] === "'") {
      const result = stringAt(raw, i)
      path.push(result.value)
      i = result.end
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(raw.slice(i))
      if (!match) throw invalid()
      path.push(match[0])
      i += match[0].length
    }
    while (/\s/.test(raw[i] || "")) i++
    if (i === raw.length) break
    if (raw[i] !== ".") throw invalid()
    i++
  }
  return path
}

function assignment(statement) {
  let quote = null
  let escaped = false
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i]
    if (quote) {
      if (escaped) { escaped = false; continue }
      if (quote === '"' && c === "\\") { escaped = true; continue }
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === "=") return [statement.slice(0, i).trim(), statement.slice(i + 1).trim()]
  }
  throw invalid()
}

function stringValue(raw) {
  const result = stringAt(raw, 0)
  if (raw.slice(result.end).trim()) throw invalid()
  return result.value
}

function stringArray(raw) {
  if (!raw.startsWith("[") || !raw.endsWith("]")) throw invalid()
  const values = []
  let i = 1
  while (i < raw.length - 1) {
    while (/\s/.test(raw[i] || "")) i++
    if (raw[i] === "]") break
    const item = stringAt(raw, i)
    values.push(item.value)
    i = item.end
    while (/\s/.test(raw[i] || "")) i++
    if (raw[i] === ",") i++
    else if (raw[i] !== "]") throw invalid()
  }
  if (raw.slice(i).trim() !== "]") throw invalid()
  return values
}

/** Return the same entry shape as serversIn(), without keeping other TOML fields. */
export function parseCodexMcpToml(text) {
  const servers = new Map()
  const nested = new Set()
  let section = []
  for (const statement of statementsOf(text.replace(/^\uFEFF/, ""))) {
    if (statement.startsWith("[")) {
      const arrayTable = statement.startsWith("[[") && statement.endsWith("]]" )
      const table = !arrayTable && statement.endsWith("]")
      if (!table && !arrayTable) throw invalid()
      section = keyPath(statement.slice(arrayTable ? 2 : 1, arrayTable ? -2 : -1).trim())
      if (section[0] !== "mcp_servers") continue
      if (arrayTable) throw unsupported()
      if (section.length > 2) nested.add(section[1])
      if (section.length === 2) {
        if (servers.has(section[1])) throw invalid()
        servers.set(section[1], { name: section[1], entry: {}, projectPath: null, seen: new Set() })
      }
      continue
    }
    const [rawKey, rawValue] = assignment(statement)
    const key = keyPath(rawKey)
    if (section.length === 0 && key[0] === "mcp_servers") throw unsupported()
    if (section[0] !== "mcp_servers") continue
    if (section.length === 1) throw unsupported()
    if (section.length !== 2 || key.length !== 1) continue
    const server = servers.get(section[1])
    const field = key[0]
    if (!["command", "args", "url", "enabled"].includes(field)) continue
    if (server.seen.has(field)) throw invalid()
    server.seen.add(field)
    if (field === "args") server.entry.args = stringArray(rawValue)
    else if (field === "enabled") {
      if (rawValue !== "true" && rawValue !== "false") throw invalid()
      server.entry.enabled = rawValue === "true"
    } else server.entry[field] = stringValue(rawValue)
  }
  for (const name of nested) if (!servers.has(name)) throw unsupported()
  return [...servers.values()].map(({ name, entry, projectPath }) => ({ name, entry, projectPath }))
}
