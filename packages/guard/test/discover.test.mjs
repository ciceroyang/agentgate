import test from "node:test"
import assert from "node:assert/strict"
import { discover, renderText, renderInventory, packageOf, hostOf, transportOf, serversIn } from "../src/discover.mjs"
import { candidateSources } from "../src/known-configs.mjs"
import { parseInventory } from "../../inventory/src/inventory.mjs"

const HOME = "/home/tester"
const ROOT = "/work/repo"

function makeFs(files) {
  return {
    exists: function (p) { return Object.prototype.hasOwnProperty.call(files, p) },
    readFile: function (p) {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error("ENOENT " + p)
      return files[p]
    },
  }
}

function run(files, extra) {
  const fs = makeFs(files)
  return discover(Object.assign({
    home: HOME, roots: [ROOT], platform: "darwin", now: "2026-09-17T00:00:00.000Z",
    exists: fs.exists, readFile: fs.readFile,
  }, extra || {}))
}

test("a project config becomes a package and an exact version", function () {
  const files = {
    "/work/repo/.mcp.json": JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2025.1.0", "/data"] } } }),
  }
  const report = run(files)
  assert.equal(report.servers.length, 1)
  assert.equal(report.servers[0].package, "@modelcontextprotocol/server-filesystem")
  assert.equal(report.servers[0].version, "2025.1.0")
  assert.equal(report.servers[0].transport, "stdio")
  assert.equal(report.incomplete, false)
  // The contract with inventory: what discover prints, --input must be able to read.
  const parsed = parseInventory(renderText(report))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].package, "@modelcontextprotocol/server-filesystem")
  assert.equal(parsed[0].version, "2025.1.0")
})

test("no env value, header or argument ever reaches the output", function () {
  const secret = "sk-live-abcdefghijklmnopqrstuvwxyz012345"
  const files = {
    "/home/tester/.cursor/mcp.json": JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.com/sse?token=" + secret, headers: { Authorization: "Bearer " + secret } } } }),
    "/work/repo/.mcp.json": JSON.stringify({ mcpServers: { local: { command: "npx", args: ["-y", "some-pkg", "--token=" + secret], env: { API_KEY: secret } } } }),
  }
  const text = JSON.stringify(run(files))
  assert.equal(text.indexOf(secret), -1, "a credential appeared in the output")
  assert.ok(text.indexOf("mcp.example.com") !== -1)
  assert.equal(text.indexOf("mcp.example.com/sse"), -1, "the path and query must be dropped")
})

test("a config that cannot be parsed is reported, not skipped, and does not hide the others", function () {
  const files = {
    "/work/repo/.mcp.json": "{ this is not json",
    "/home/tester/.cursor/mcp.json": JSON.stringify({ mcpServers: { ok: { command: "npx", args: ["-y", "good-pkg@1.0.0"] } } }),
  }
  const report = run(files)
  assert.equal(report.incomplete, true)
  assert.equal(report.counts.sourcesIncomplete, 1)
  assert.equal(report.servers.length, 1, "the readable source must still be listed")
  assert.equal(report.sources.filter(function (s) { return s.reason === "invalid-json" })[0].status, "unparsed")
})

test("Codex TOML discovers MCP tables without reading nested env as a server", function () {
  const secret = "sk-live-abcdefghijklmnopqrstuvwxyz012345"
  const files = { "/home/tester/.codex/config.toml": [
    'title = """', '[mcp_servers.decoy]', '"""',
    '[mcp_servers."real.server"]', "command = 'npx'", "args = [", "  '-y',", "  '@scope/pkg@1.2.3', # pinned package", `  '--token=${secret}'`, "]",
    `env = { KEY = '${secret}' }`,
    '[mcp_servers."real.server".env]', `KEY = '${secret}'`,
    '[mcp_servers.disabled]', "command = 'npx'", "args = ['disabled-pkg@2.0.0']", "enabled = false",
    '[mcp_servers.remote]', `url = 'https://user:${secret}@example.com/sse?token=${secret}'`,
  ].join("\n") }
  const report = run(files)
  assert.equal(report.incomplete, false)
  assert.equal(report.sources.length, 1)
  assert.equal(report.sources[0].status, "read")
  assert.equal(report.sources[0].servers, 3)
  assert.equal(report.servers.length, 3)
  assert.equal(report.counts.serversDisabled, 1)
  assert.equal(report.counts.serversExported, 2)
  assert.equal(report.counts.exportedPackagesUnknown, 1)
  assert.equal(report.counts.exportedVersionsUnknown, 1)
  assert.equal(report.servers.find(s => s.name === "real.server").package, "@scope/pkg")
  assert.equal(report.servers.find(s => s.name === "real.server").version, "1.2.3")
  assert.equal(report.servers.find(s => s.name === "real.server").identityStatus, "declared-package-version")
  assert.equal(report.servers.find(s => s.name === "remote").host, "example.com")
  assert.equal(report.servers.find(s => s.name === "remote").identityStatus, "remote-host-only")
  assert.equal(report.servers.find(s => s.name === "disabled").enabled, false)
  assert.equal(renderText(report).includes("disabled-pkg"), false)
  const inventory = parseInventory(renderInventory(report))
  assert.equal(inventory.length, 2)
  assert.equal(JSON.stringify(report).includes(secret), false)
  assert.equal(renderInventory(report).includes(secret), false)
})

test("unsupported or malformed Codex MCP TOML stays incomplete", function () {
  const unsupported = run({ "/home/tester/.codex/config.toml": "[mcp_servers]\nfoo = { command = 'npx' }\n" })
  assert.equal(unsupported.incomplete, true)
  assert.equal(unsupported.sources[0].reason, "unsupported-mcp-toml")
  const malformed = run({ "/home/tester/.codex/config.toml": "[mcp_servers.foo]\nargs = ['unfinished'\n" })
  assert.equal(malformed.incomplete, true)
  assert.equal(malformed.sources[0].reason, "invalid-toml")
  assert.equal(malformed.servers.length, 0)
  const implicit = run({ "/home/tester/.codex/config.toml": "[mcp_servers.foo.env]\nTOKEN = 'secret'\n" })
  assert.equal(implicit.sources[0].reason, "unsupported-mcp-toml")
})

test("an opaque local command remains an unresolved identity and version", function () {
  const report = run({ "/home/tester/.codex/config.toml": "[mcp_servers.'custom@1.2.3']\ncommand = '/opt/company/mcp-server'\nargs = ['--token=private']\n" })
  assert.equal(report.incomplete, false, "the config was parsed, even though identity was not")
  assert.equal(report.servers[0].identityStatus, "unresolved")
  assert.equal(report.servers[0].package, null)
  assert.equal(report.servers[0].version, null)
  const roundTrip = parseInventory(renderText(report))
  assert.equal(roundTrip[0].name, "custom@1.2.3")
  assert.equal(roundTrip[0].package, null)
  assert.equal(roundTrip[0].version, null)
  assert.equal(JSON.stringify(report).includes("private"), false)
})

test("explicitly disabled JSON servers are retained for audit but not exported", function () {
  const files = { "/work/repo/.mcp.json": JSON.stringify({ mcpServers: {
    off: { command: "npx", args: ["off-pkg@1.0.0"], enabled: false },
    on: { command: "npx", args: ["on-pkg@1.0.0"] },
  } }) }
  const report = run(files)
  assert.equal(report.servers.length, 2)
  assert.equal(report.counts.serversDisabled, 1)
  assert.equal(renderText(report).trim(), "npm:on-pkg@1.0.0")
  assert.equal(parseInventory(renderInventory(report)).length, 1)
})

test("a file that cannot be read is reported as unreadable", function () {
  const files = { "/work/repo/.mcp.json": JSON.stringify({ mcpServers: {} }) }
  const fs = makeFs(files)
  const report = discover({
    home: HOME, roots: [ROOT], platform: "darwin", now: "T",
    exists: function () { return true },
    readFile: function () { throw new Error("EACCES") },
  })
  assert.equal(report.incomplete, true)
  assert.equal(report.sources[0].reason, "read-failed")
})

test("claude-code keeps servers per project, as a map or as an array", function () {
  const files = {
    "/home/tester/.claude.json": JSON.stringify({
      projects: {
        "/work/a": { mcpServers: { one: { command: "npx", args: ["-y", "pkg-one"] } } },
        "/work/b": { mcpServers: [{ name: "two", command: "uvx", args: ["mcp-server-git"] }, "three"] },
      },
    }),
  }
  const report = run(files)
  const names = report.servers.map(function (s) { return s.name }).sort()
  assert.deepEqual(names, ["one", "three", "two"])
  const two = report.servers.filter(function (s) { return s.name === "two" })[0]
  assert.equal(two.registry, "pypi")
  assert.equal(two.package, "mcp-server-git")
  assert.equal(report.servers.filter(function (s) { return s.name === "three" })[0].transport, "unknown")
})

test("the same server in two places is one entry that names both sources", function () {
  const files = {
    "/home/tester/.cursor/mcp.json": JSON.stringify({ mcpServers: { shared: { command: "npx", args: ["-y", "shared-pkg@2.0.0"] } } }),
    "/work/repo/.mcp.json": JSON.stringify({ mcpServers: { shared: { command: "npx", args: ["-y", "shared-pkg@2.0.0"] } } }),
  }
  const report = run(files)
  assert.equal(report.servers.length, 1)
  assert.equal(report.servers[0].version, "2.0.0", "only identical versions are merged")
  assert.deepEqual(report.servers[0].from.sort(), ["/home/tester/.cursor/mcp.json", "/work/repo/.mcp.json"])
  assert.deepEqual(report.servers[0].scopes.sort(), ["machine", "project"])
})

test("nothing found is not an error and produces no lines", function () {
  const report = run({})
  assert.equal(report.incomplete, false)
  assert.equal(report.counts.sourcesFound, 0)
  assert.equal(report.servers.length, 0)
  assert.equal(renderText(report), "")
})

test("platform decides which home paths are candidates", function () {
  const files = { "/home/tester/.config/Claude/claude_desktop_config.json": JSON.stringify({ mcpServers: { l: { command: "node", args: ["s.js"] } } }) }
  const onLinux = run(files, { platform: "linux" })
  const onDarwin = run(files, { platform: "darwin" })
  assert.equal(onLinux.counts.sourcesFound, 1)
  assert.equal(onDarwin.counts.sourcesFound, 0)
})

test("a command that is not a package runner yields no package", function () {
  assert.equal(packageOf("node", ["/srv/server.js"]), null)
  assert.equal(packageOf("/usr/local/bin/python3", ["-m", "thing"]), null)
  assert.equal(packageOf("pnpm", ["dlx", "tool@1.2.0"]).package, "tool")
  assert.equal(packageOf("npx", ["-y", "."]), null)
  assert.equal(packageOf("uvx", ["mcp-server-git==1.2.3"]).version, "1.2.3")
})

test("a url that cannot be parsed is not printed as a host", function () {
  assert.equal(hostOf("not a url"), null)
  assert.equal(hostOf("https://user:pass@host.example.com/x?k=v"), "host.example.com")
  assert.equal(transportOf({ url: "wss://h/x" }), "ws")
})

test("serversIn ignores documents without the expected shape", function () {
  assert.deepEqual(serversIn({ nope: 1 }, "mcpServers"), [])
  assert.deepEqual(serversIn(null, "mcpServers"), [])
  assert.deepEqual(serversIn({ mcpServers: [] }, "mcpServers"), [])
})

test("candidateSources never invents an absolute path when home is missing", function () {
  const sources = candidateSources({ home: null, roots: ["/r"], platform: "darwin" })
  assert.ok(sources.every(function (s) { return s.scope === "project" }))
})
