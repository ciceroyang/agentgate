#!/usr/bin/env node
/**
 * The one entry point.
 *
 *   agentgate serve     start the evidence service
 *   agentgate refresh   rebuild the index from public sources
 *   agentgate version
 */
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { execFileSync, spawnSync } from "node:child_process"
import { start } from "../packages/service/src/start.mjs"
import { installShutdown } from "../packages/service/src/observability.mjs"
import { DEFAULT_PORT, DEFAULT_HOST } from "../packages/service/src/defaults.mjs"
import { runScan } from "../packages/guard/src/engine.mjs"
import { makeReader } from "../packages/guard/src/fs-scan.mjs"
import { discover, renderText, renderInventory } from "../packages/guard/src/discover.mjs"
import { ALL_CHECKS } from "../packages/guard/src/checks/index.mjs"
import { loadPolicy, defaultPolicy } from "../packages/policy/src/policy.mjs"
import { evaluate, exitCodeFor } from "../packages/policy/src/evaluate.mjs"
import { aggregateAudit, renderAudit } from "../packages/policy/src/audit.mjs"
import { toSarif } from "../packages/policy/src/sarif.mjs"
import { toHtmlReport } from "../packages/policy/src/html-report.mjs"
import { diffIndex, renderDiff } from "../packages/history/src/diff.mjs"
import { readLedger, verifyLedger, backfill } from "../packages/history/src/ledger.mjs"
import { createProxy } from "../packages/gateway/src/proxy.mjs"
import { parseInventory, createInventoryReport } from "../packages/inventory/src/inventory.mjs"
import { appendWatch, readWatch, verifyWatch, webhookPayload } from "../packages/watch/src/watch.mjs"
import { frameworkById, renderFrameworkText } from "../packages/policy/src/framework.mjs"
import { renderInventoryReport } from "../packages/inventory/src/report.mjs"
import { listTools, createToolHandlers } from "../packages/mcp/src/tools.mjs"
import { startMcpServer } from "../packages/mcp/src/server.mjs"
import { buildPack, writePack, verifyPack } from "../packages/pack/src/pack.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// Read the published version instead of writing it down twice: the two copies drifted
// once, and "agentgate version" reported a number the package no longer had.
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version


function parse(argv) {
  const args = { command: argv[0] || "help", flags: {}, rest: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--") { args.rest = argv.slice(i + 1); break }
    if (a.indexOf("--") === 0) args.flags[a.slice(2)] = argv[i + 1] && argv[i + 1].indexOf("--") !== 0 ? argv[++i] : true
    else args.rest.push(a)
  }
  return args
}

/** Where the index lives when the user did not say. A refreshed index is written next to the
 *  project (./data), so look there first; an installed package falls back to the snapshot it
 *  was published with, which is why that snapshot has to be in "files". */
function resolveIndex(flags) {
  const candidates = [
    flags.index || process.env.AGENTGATE_INDEX,
    join(process.cwd(), "data", "index.json"),
    join(ROOT, "data", "index.json"),
    join(process.cwd(), "data", "sample-index.json"),
    join(ROOT, "data", "sample-index.json"),
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return { path: resolve(c), why: c === candidates[0] && (flags.index || process.env.AGENTGATE_INDEX) ? "chosen" : "found" }
  return { path: resolve(candidates[0] || join(process.cwd(), "data", "index.json")), why: "none" }
}

function serve(flags) {
  const chosen = resolveIndex(flags)
  const indexPath = chosen.path
  const samplePath = resolve(flags.sample || process.env.AGENTGATE_SAMPLE || join(ROOT, "data", "sample-index.json"))
  const requested = flags.port !== undefined ? flags.port : (process.env.AGENTGATE_PORT !== undefined ? process.env.AGENTGATE_PORT : DEFAULT_PORT)
  const port = Number(requested)
  const host = flags.host || process.env.AGENTGATE_HOST || DEFAULT_HOST
  const which = existsSync(indexPath) ? indexPath : (existsSync(samplePath) ? samplePath + " (committed sample)" : "none")
  const server = start({
    indexPath: indexPath, samplePath: samplePath, port: port, host: host,
    historyPath: flags.history || process.env.AGENTGATE_HISTORY || join(dirname(resolve(indexPath)), "history"),
    // Off unless asked for: an access log is operational data, and the data-handling page says
    // what is and is not recorded.
    accessLog: process.env.AGENTGATE_ACCESS_LOG === "1" || process.env.AGENTGATE_ACCESS_LOG === "true",
    // Print the port the socket actually got. With --port 0 the requested port is not the one
    // anything can connect to, and a caller that cannot learn it has to guess.
    onListening: function () {
      const bound = server.address() && server.address().port
      console.log("agentgate serving http://" + host + ":" + bound)
      console.log("index: " + which)
      console.log("my tools: http://" + host + ":" + bound + "/inventory.html")
      console.log("routes: /health /metrics /v1/index/summary /v1/servers /v1/servers/:name /badge/:name.svg")
    },
  })
  // systemd sends SIGTERM on stop and on deploy; finish the request in flight, then leave.
  installShutdown(server)
}

function refresh(flags) {
  const max = String(flags.max || 300)
  // Written next to the caller, not inside the package: an installed package may be read-only,
  // and a refresh should never scribble under node_modules.
  const dataDir = process.env.AGENTGATE_DATA || join(process.cwd(), "data")
  const run = function (label, script, args) {
    process.stderr.write("[refresh] " + label + "\n")
    const out = spawnSync(process.execPath, [script].concat(args), { stdio: "inherit", cwd: ROOT })
    if (out.status !== 0) { console.error("[refresh] " + label + " failed with exit " + out.status); process.exit(out.status || 1) }
  }
  run("census", join(ROOT, "packages", "collect", "mcp-audit.mjs"), ["--max", "6000", "--out", join(dataDir, "census.json"), "--markdown", join(dataDir, "census.md")])
  run("guard-scan", join(ROOT, "packages", "collect", "scripts", "guard-scan.mjs"), ["--census", join(dataDir, "census.json"), "--max", max, "--out", join(dataDir, "guard-scan.json")])
  // The repository side of the chain. It is a separate, slower job (`--repositories`) because a
  // full enumeration of a GitHub topic is over an hour; the daily run only reads what that job
  // left behind. When the artifacts are absent the index is exactly what it was before.
  const repoCensus = join(dataDir, "github-census.json")
  const repoClassification = join(dataDir, "repository-classification.json")
  const repoAudit = join(dataDir, "package-audit.json")
  if (flags.repositories) {
    let since = "2015-01-01"
    try {
      const previous = JSON.parse(readFileSync(repoCensus, "utf8"))
      if (previous.generatedAt) since = new Date(Date.parse(previous.generatedAt) - 86400000).toISOString().slice(0, 10)
    } catch (error) { /* first run: the whole topic */ }
    const githubArgs = ["--topic", "mcp-server", "--min-stars", "1", "--out", repoCensus]
    if (since !== "2015-01-01") githubArgs.push("--since", since)
    if (flags.token && flags.token !== true) githubArgs.push("--token", String(flags.token))
    run("github-census", join(ROOT, "packages", "collect", "github-census.mjs"), githubArgs)
    const classifyArgs = ["--census", repoCensus, "--out", repoClassification, "--rate", String(flags.rate || "1.3")]
    if (flags.token && flags.token !== true) classifyArgs.push("--token", String(flags.token))
    run("classify-repositories", join(ROOT, "packages", "collect", "scripts", "classify-repositories.mjs"), classifyArgs)
  }
  // The deployed commit is the cheapest honest identifier of "which scanner ran". It moves when
  // the rules move, which is what a later diff needs to know.
  let scanner = "unknown"
  try { scanner = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() } catch (error) { scanner = "unknown" }
  const indexArgs = ["--census", join(dataDir, "census.json"), "--guard", join(dataDir, "guard-scan.json"), "--scanner", scanner, "--out", join(dataDir, "index.json")]
  if (existsSync(repoCensus) && existsSync(repoClassification)) {
    indexArgs.push("--github", repoCensus, "--classification", repoClassification)
    process.stderr.write("[refresh] repository records: on (" + repoCensus + ")\n")
  }
  // Without this the audit is dropped on every refresh and the published index quietly goes back to
  // "we know a package is declared" for all of them. build-index takes --audit either way; leaving
  // it out here is silence, not a decision.
  if (existsSync(repoAudit)) {
    indexArgs.push("--audit", repoAudit)
    process.stderr.write("[refresh] package audit: on (" + repoAudit + ")\n")
  }
  run("index", join(ROOT, "packages", "collect", "scripts", "build-index.mjs"), indexArgs)
  console.log("[refresh] done: " + join(dataDir, "index.json"))
}

function recordsFor(root, indexPath) {
  if (!indexPath) return null
  if (indexPath === true) throw new Error("--index requires a file path")
  const index = JSON.parse(readFileSync(indexPath, "utf8"))
  if (!index || !Array.isArray(index.records)) throw new Error("index.records must be an array")
  if (index.snapshot === true || index.sample === true) throw new Error("a historical sample cannot support a policy decision")
  let pkg
  try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) } catch { return [] }
  if (!pkg.name || !pkg.version) return []
  return index.records.filter(function (r) {
    return Array.isArray(r?.packages) && r.packages.some(function (p) { return p.registry === "npm" && p.name === pkg.name && p.version === pkg.version })
  })
}

/** One directory: policy, scan, evaluation. Fatal input errors exit here; the caller decides the rest. */
function runCheck(root, flags) {
  const policyPath = flags.policy || join(root, "agentgate.policy.json")
  let policy
  let policyNote = null
  if (!flags.policy && !existsSync(policyPath)) {
    policy = defaultPolicy()
    policyNote = "built-in default: nothing extra is refused. Write " + join(root, "agentgate.policy.json") + " to refuse specific rules, servers or tools."
  } else {
    try { policy = loadPolicy(policyPath) } catch (error) {
      console.error("policy: " + error.message)
      process.exit(3)
    }
  }
  const exclude = String(flags.exclude || "node_modules,.git").split(",").filter(Boolean)
  let checks = ALL_CHECKS
  if (flags.checks) {
    // A named check that does not exist is an error, not a silently skipped one: running three of
    // four checks and reporting on the fourth is the failure this whole project is about.
    const wanted = String(flags.checks).split(",").map(function (s) { return s.trim() }).filter(Boolean)
    const known = ALL_CHECKS.map(function (c) { return c.id })
    const unknown = wanted.filter(function (w) { return known.indexOf(w) === -1 })
    if (unknown.length > 0) {
      console.error("checks: no such check: " + unknown.join(", ") + "\nknown: " + known.join(", "))
      process.exit(3)
    }
    checks = ALL_CHECKS.filter(function (c) { return wanted.indexOf(c.id) !== -1 })
  }
  const scan = runScan({ root: root, checks: checks, readText: makeReader(), exclude: exclude })
  let records
  try { records = recordsFor(root, flags.index || process.env.AGENTGATE_INDEX) }
  catch (error) { console.error("index: " + error.message); process.exit(3) }
  const result = evaluate({ policy: policy, scan: scan, records: records })
  const lines = []
  lines.push("policy " + result.policyVersion + "   root " + root)
  if (checks !== ALL_CHECKS) lines.push("checks " + checks.map(function (c) { return c.id }).join(", ") + " (of the " + ALL_CHECKS.length + " available: this run measured less, and the verdict says so)")
  if (policyNote) lines.push(policyNote)
  lines.push("")
  for (const f of result.findings) {
    lines.push("  " + String(f.severity).toUpperCase().padEnd(9) + f.rule + "  " + (f.file || "") + "  " + f.reason)
    lines.push("            " + String(f.message).slice(0, 100))
  }
  if (result.findings.length === 0) lines.push("  nothing refused")
  if (result.coverage.evidenceMissing.length > 0) {
    lines.push("")
    lines.push("  could not be measured:")
    for (const m of result.coverage.evidenceMissing.slice(0, 10)) lines.push("    " + m.server + " / " + m.block + " -> " + m.reason)
    if (result.coverage.evidenceMissing.length > 10) lines.push("    ... and " + (result.coverage.evidenceMissing.length - 10) + " more")
  }
  if (result.coverage.checksFailed.length > 0) {
    lines.push("")
    for (const c of result.coverage.checksFailed) lines.push("  CHECK FAILED: " + c.id + " -> " + c.error)
  }
  lines.push("")
  lines.push("  verdict: " + result.verdict.toUpperCase() + (result.verdict === "incomplete" ? "  (this is not a pass)" : ""))
  return { result: result, policy: policy, human: lines.join("\n") }
}

function renderResult(run, root, flags) {
  const format = flags.format || "console"
  return format === "sarif" ? toSarif(run.result, { version: VERSION })
    : format === "json" ? JSON.stringify(run.result, null, 2)
    : format === "html" ? toHtmlReport(run.result, { root: root, policy: run.policy, generatedAt: new Date().toISOString(), lang: flags.lang })
    : run.human
}

function check(flags) {
  if (flags.lang !== undefined && !["zh-CN", "en"].includes(flags.lang)) {
    console.error("check: --lang only supports zh-CN or en")
    process.exit(3)
  }
  const root = resolve(flags.root || ".")
  const run = runCheck(root, flags)
  const rendered = renderResult(run, root, flags)
  if (flags.out) {
    writeFileSync(flags.out, rendered + "\n")
    process.stdout.write(run.human + "\n")
  } else {
    process.stdout.write(rendered + "\n")
  }
  process.exit(exitCodeFor(run.result))
}

/**
 * Record a customer's tool list, say what changed since the last time, and - only when a
 * webhook was named - push that summary. The archive is written before the push: a chat
 * service being down must not lose the capture.
 */
async function watchCommand(flags) {
  const archive = resolve(String(flags.archive || "agentgate-watch"))
  if (flags.verify) {
    if (!existsSync(join(archive, "watch.jsonl"))) {
      console.error("watch: 没有归档可验证：" + join(archive, "watch.jsonl"))
      process.exit(3)
    }
    const result = verifyWatch(archive)
    for (const problem of result.problems) console.error("  " + problem.problem + "  " + problem.detail)
    console.log("captures verified: " + result.captures + (result.ok ? "，链与快照一致" : "，有不一致"))
    process.exit(result.ok ? 0 : 1)
  }
  if (typeof flags.input !== "string") {
    console.error("usage: agentgate watch --input tools.txt [--archive dir] [--index data/index.json] [--webhook URL] [--webhook-format raw|wecom|feishu|slack]\n       agentgate watch --verify [--archive dir]")
    process.exit(3)
  }
  if (flags.webhook === true) { console.error("watch: --webhook 需要一个 URL"); process.exit(3) }
  const chosen = resolveIndex(flags)
  const indexPath = flags.index || process.env.AGENTGATE_INDEX || chosen.path
  let entries
  let index
  try {
    entries = parseInventory(readFileSync(flags.input, "utf8"))
  } catch (error) { console.error("watch: " + error.message); process.exit(3) }
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"))
  } catch (error) { console.error("watch: 读不了索引 " + indexPath + "：" + error.message); process.exit(3) }
  const report = createInventoryReport(entries, index, { generatedAt: new Date().toISOString() })
  const result = appendWatch(archive, { entries: entries, report: report })
  if (flags.format === "json") {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, firstRun: result.firstRun, comparable: result.comparable, summary: result.summary, diff: result.diff, entry: result.entry }, null, 2) + "\n")
  } else process.stdout.write(result.summary + "\n")
  console.error("归档：" + join(archive, "watch.jsonl") + "（第 " + readWatchLines(archive) + " 条）")
  if (flags.webhook) {
    let payload
    try {
      payload = webhookPayload(String(flags["webhook-format"] || "raw"), result.summary, result.diff, result.entry.capturedAt)
    } catch (error) { console.error("watch: " + error.message); process.exit(3) }
    try {
      const controller = new AbortController()
      const timer = setTimeout(function () { controller.abort() }, 10000)
      const response = await fetch(String(flags.webhook), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal,
      })
      clearTimeout(timer)
      if (!response.ok) throw new Error("HTTP " + response.status)
      console.error("已推送到 " + String(flags.webhook))
    } catch (error) {
      console.error("watch: 推送失败：" + ((error && error.message) || error) + "（归档已经写入，没有丢数据）")
      process.exit(3)
    }
  }
  process.exit(0)
}

function readWatchLines(archive) {
  try { return readFileSync(join(archive, "watch.jsonl"), "utf8").trim().split("\n").filter(Boolean).length } catch (error) { return 0 }
}

/**
 * The same scan, once per repository, with one verdict for the set.
 *
 * A directory that does not exist is not skipped: it is an unmeasured repository, which makes
 * the whole audit incomplete. That is the only honest reading of "scan these ten repos".
 */
function audit(flags) {
  if (flags.roots === true || !String(flags.roots || "").trim()) {
    console.error("usage: agentgate audit --roots repoA,repoB [--policy p.json] [--index data/index.json] [--fail-on medium] [--format text|json] [--out file]")
    process.exit(3)
  }
  const roots = String(flags.roots).split(",").map(function (s) { return resolve(s.trim()) }).filter(Boolean)
  const entries = []
  for (const root of roots) {
    if (!existsSync(root)) {
      entries.push({ root: root, verdict: "incomplete", exitCode: 2, findings: 0, checksFailed: 0, evidenceMissing: 0, reason: "目录不存在" })
      continue
    }
    const run = runCheck(root, flags)
    entries.push({
      root: root,
      verdict: run.result.verdict,
      exitCode: exitCodeFor(run.result),
      findings: run.result.findings.length,
      rules: Array.from(new Set(run.result.findings.map(function (f) { return f.rule }))).slice(0, 3),
      checksFailed: run.result.coverage.checksFailed.length,
      evidenceMissing: run.result.coverage.evidenceMissing.length,
      reason: null,
    })
  }
  const aggregate = aggregateAudit(entries)
  if (flags.format === "json") process.stdout.write(JSON.stringify({ schemaVersion: 1, aggregate: aggregate, entries: entries }, null, 2) + "\n")
  else process.stdout.write(renderAudit(entries, aggregate) + "\n")
  process.exit(aggregate.exitCode)
}

function diff(flags) {
  if (!flags.from || !flags.to) { console.error("usage: agentgate diff --from old-index.json --to new-index.json"); process.exit(3) }
  const from = JSON.parse(readFileSync(flags.from, "utf8"))
  const to = JSON.parse(readFileSync(flags.to, "utf8"))
  const d = diffIndex(from, to)
  const text = (flags.format === "json") ? JSON.stringify(d, null, 2) : renderDiff(d)
  if (flags.out) writeFileSync(flags.out, text + "\n")
  process.stdout.write(text + "\n")
  process.exit(d.silent.length > 0 ? 1 : 0)
}

/**
 * The capture ledger: one chained line per index build.
 *
 * Exit 0 means the chain and every retained snapshot re-hash. Exit 1 means the record has been
 * edited. A missing snapshot is reported separately: pruning old content is a storage decision,
 * and the chain still proves the capture happened.
 */
function history(flags) {
  const dir = flags.history || "data/history"
  const maxAge = flags["max-age"] !== undefined ? Number(flags["max-age"]) : null
  if (flags.backfill) {
    const added = backfill(dir)
    console.log(added.length === 0 ? "nothing to backfill" : "backfilled " + added.length + " capture(s) from the day archives")
  }
  const result = verifyLedger(dir, maxAge !== null ? { maxAgeHours: maxAge } : {})
  const coverage = result.coverage
  if (flags.format === "json") {
    process.stdout.write(JSON.stringify({ ok: result.ok, problems: result.problems, notRetained: result.notRetained, coverage: coverage, entries: result.entries }, null, 2) + "\n")
    process.exit(result.ok ? 0 : 1)
  }
  console.log("captures: " + coverage.captures + " over " + coverage.days + " day(s), " + (coverage.first || "(none)") + " .. " + (coverage.last || "(none)") + (result.ageHours !== null ? " (last " + result.ageHours.toFixed(1) + "h ago)" : ""))
  if (coverage.gaps.length > 0) console.log("missing day(s): " + coverage.gaps.join(", "))
  if (result.notRetained.length > 0) console.log("snapshot(s) no longer retained: " + result.notRetained.length)
  for (const entry of result.entries.slice(-5)) {
    console.log("  " + entry.capturedAt + "  " + entry.records + " records  clean " + entry.counts.clean + " / findings " + entry.counts.findings + " / incomplete " + entry.counts.incomplete + "  " + (entry.scanner || "(no scanner)") + "  " + String(entry.sha256).slice(0, 12))
  }
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error("FAIL  " + problem)
    process.exit(1)
  }
  console.log("chain verified: every line's prev matches the line before it, and every retained snapshot hashes to what was recorded")
  process.exit(0)
}

const args = parse(process.argv.slice(2))
function inventory(flags) {
  try {
    if (typeof flags.input !== "string") throw new Error("请用 --input 指定工具清单（文本或 JSON），不会自动读取你的配置。")
    const format = flags.format || "html"
    if (!["html", "json"].includes(format)) throw new Error("清单报告格式只支持 html 或 json。")
    if (flags.out !== undefined && typeof flags.out !== "string") throw new Error("--out 需要一个输出文件路径。")
    if (flags.index !== undefined && typeof flags.index !== "string") throw new Error("--index 需要一个索引文件路径。")
    const chosen = resolveIndex(flags)
    // An explicit index must never silently fall back to the committed sample.
    const indexPath = flags.index || process.env.AGENTGATE_INDEX || chosen.path
    if (statSync(flags.input).size > 1024 * 1024) throw new Error("工具清单不能超过 1 MB。")
    const entries = parseInventory(readFileSync(flags.input, "utf8"))
    const index = JSON.parse(readFileSync(indexPath, "utf8"))
    if (!index || !Array.isArray(index.records)) throw new Error("证据索引缺少 records 列表，无法生成报告。")
    let framework = null
    if (flags.framework !== undefined) {
      if (flags.framework === true) { console.error("inventory: --framework 需要一个框架 id，例如 aicaiq"); process.exit(3) }
      try { framework = frameworkById(String(flags.framework)) } catch (error) { console.error("inventory: " + error.message); process.exit(3) }
      if (String(flags.framework) !== framework.id) console.error("inventory: --framework " + String(flags.framework) + " 指向 " + framework.name + "；AICM 控制集本身还没有逐条映射。")
    }
    const report = createInventoryReport(entries, index, { generatedAt: new Date().toISOString() })
    const rendered = format === "json" ? JSON.stringify(framework ? Object.assign({}, report, { framework: framework }) : report, null, 2) : renderInventoryReport(report, { framework: framework })
    if (flags.out) {
      if ([flags.input, indexPath].some(function (p) { return resolve(p) === resolve(flags.out) })) throw new Error("报告不能覆盖输入清单或证据索引。")
      // Reports can contain a private inventory. Do not overwrite a previous report implicitly.
      writeFileSync(flags.out, rendered + "\n", { flag: "wx", mode: 0o600 })
      console.log("清单报告已保存：" + resolve(flags.out))
      console.log("共 " + report.summary.total + " 项；需要补充或确认 " + report.summary.needsAttention + " 项。报告生成不代表安全通过。")
    } else process.stdout.write(rendered + "\n")
    // This is report generation, not the policy check command: unknowns are retained in the report.
  } catch (error) {
    console.error("inventory: " + error.message)
    process.exitCode = 2
  }
}
/**
 * The list a customer cannot produce by hand, produced from what is already on the machine.
 * Nothing leaves the process: there is no request here, and no argument or env value is printed.
 */
function discoverCommand(flags) {
  if (flags.home === true) { console.error("discover: --home needs a directory"); process.exit(3) }
  if (flags.roots === true) { console.error("discover: --roots needs a comma-separated list of directories"); process.exit(3) }
  const home = flags.home ? resolve(String(flags.home)) : homedir()
  const roots = String(flags.roots || ".").split(",").map(function (s) { return resolve(s.trim()) }).filter(Boolean)
  const format = flags.format || "text"
  if (["text", "json", "inventory"].indexOf(format) === -1) { console.error("discover: --format only supports text, json or inventory"); process.exit(3) }
  const report = discover({
    home: home,
    roots: roots,
    platform: process.platform,
    exists: existsSync,
    readFile: function (p) { return readFileSync(p, "utf8") },
  })
  const rendered = format === "json" ? JSON.stringify(report, null, 2) : format === "inventory" ? renderInventory(report) : renderText(report)
  if (report.conflicts.length) console.error("discover: 相同别名对应不同身份或版本，已全部保留，请核对：" + report.conflicts.join(", "))
  if (flags.out) {
    if (resolve(String(flags.out)) === resolve(join(home, ".claude.json"))) { console.error("discover: 报告不能覆盖配置文件"); process.exit(3) }
    try {
      writeFileSync(String(flags.out), rendered, { flag: "wx", mode: 0o600 })
    } catch (error) {
      console.error("discover: 写不了 " + resolve(String(flags.out)) + "：" + error.message + "（已有文件不会被覆盖）")
      process.exit(3)
    }
    console.error("清单已保存：" + resolve(String(flags.out)))
  } else process.stdout.write(rendered)
  const bad = report.sources.filter(function (s) { return s.status !== "read" })
  console.error("找到 " + report.counts.sourcesFound + " 个配置文件，读到 " + report.counts.sourcesRead + " 个；配置服务器 " + report.counts.servers + " 个（明确禁用 " + report.counts.serversDisabled + " 个，导出 " + report.counts.serversExported + " 个）。")
  if (report.counts.exportedPackagesUnknown || report.counts.exportedVersionsUnknown) {
    console.error("导出项中 " + report.counts.exportedPackagesUnknown + " 个没有可识别包坐标，" + report.counts.exportedVersionsUnknown + " 个没有可提取的声明版本；不能把这些未知当成索引未覆盖或运行时已核实。")
  }
  for (const s of bad) console.error("  没读成： " + s.abs + "  (" + s.reason + ")")
  if (report.incomplete) console.error("这份清单不完整：" + bad.length + " 个来源存在但没读成，别把它当成全部。")
  // Same rule as everywhere else: a list that is missing something does not exit 0.
  process.exitCode = report.incomplete ? 2 : 0
}
/** Print the questionnaire mapping on its own, without a tool list. */
function framework(flags) {
  const id = flags.id === undefined || flags.id === true ? "aicaiq" : String(flags.id)
  let chosen
  try { chosen = frameworkById(id) } catch (error) { console.error("framework: " + error.message); process.exit(3) }
  const rendered = flags.format === "json" ? JSON.stringify(chosen, null, 2) : renderFrameworkText(chosen)
  if (flags.out) {
    try { writeFileSync(String(flags.out), rendered + "\n", { flag: "wx", mode: 0o600 }) } catch (error) { console.error("framework: 写不了： " + error.message); process.exit(3) }
    console.error("已保存：" + resolve(String(flags.out)))
  } else process.stdout.write(rendered + "\n")
  process.exit(0)
}
/**
 * The MCP server, over stdio.
 *
 * It reads the same index the rest of the CLI reads, and it serves three read-only answers about
 * it plus a scan of a local directory. It never writes to the index and never opens a socket: the
 * point of the tool is that an agent can ask what is known, and the answer is the record.
 */
function mcp(flags) {
  // An explicit --index is a decision, not a preference: falling back to the packaged sample
  // because the named file is missing would answer questions about a demonstration as if it were
  // the collection. When nothing is named, resolveIndex may still land on the sample, and then the
  // answers say so.
  const explicit = flags.index || process.env.AGENTGATE_INDEX || null
  const chosen = explicit ? { path: resolve(String(explicit)), why: "chosen" } : resolveIndex(flags)
  let index = null
  let indexNote = null
  let indexWarning = null
  if (!existsSync(chosen.path)) {
    indexNote = "no index at " + chosen.path
  } else {
    try {
      index = JSON.parse(readFileSync(chosen.path, "utf8"))
      if (String(chosen.path).indexOf("sample-index.json") !== -1) {
        indexWarning = "index warning: this is the historical sample index that ships with the package, not the live collection. The numbers are a demonstration."
      }
    } catch (error) {
      indexNote = "the index at " + chosen.path + " could not be parsed: " + error.message
    }
  }
  const handlers = createToolHandlers({ index: index, indexNote: indexNote, indexWarning: indexWarning })
  process.stderr.write("agentgate mcp: index " + (index ? chosen.path + " (" + (index.records || []).length + " records)" : "none - the tools will say how to build one") + "\n")
  if (indexWarning) process.stderr.write("agentgate mcp: " + indexWarning + "\n")
  startMcpServer({ tools: listTools(), callTool: handlers.callTool, version: VERSION })
}

function proxy(flags, rest) {
  if (rest.length === 0) { console.error("usage: agentgate proxy --policy policy.json [--log calls.jsonl] -- <server command> [args...]"); process.exit(3) }
  let policy
  try { policy = loadPolicy(flags.policy || "agentgate.policy.json") } catch (error) { console.error("policy: " + error.message); process.exit(3) }
  const logPath = flags.log || "agentgate-calls.jsonl"
  process.stderr.write("agentgate proxy: starting server (command and arguments withheld)\n")
  process.stderr.write("agentgate proxy: decisions logged to " + logPath + "\n")
  createProxy({
    command: rest[0],
    args: rest.slice(1),
    policy: policy,
    logPath: logPath,
    out: process.stdout,
    input: process.stdin,
    onExit: function (code, stats) {
      process.stderr.write("agentgate proxy: " + JSON.stringify(stats) + "\n")
      process.exit(code === null ? 0 : code)
    },
  })
}

/**
 * One directory a vendor can hand to the person reviewing them.
 *
 * The pack adds no new measurement: it is built from the same index, inventory parser and archive
 * the other commands use. Its exit code keeps the meaning it has everywhere else - 2 when
 * something we claim is unmeasured, 1 when there is a finding to look at, 0 otherwise.
 */
function packCommand(flags) {
  if (flags.verify !== undefined) {
    if (flags.verify === true) { console.error("pack: --verify 需要一个目录"); process.exit(3) }
    const result = verifyPack(String(flags.verify))
    for (const problem of result.problems) console.error("pack --verify: " + problem.detail)
    if (result.extra.length > 0) console.error("pack --verify: 目录里多出来的文件（不在清单内，不影响结论）：" + result.extra.join(", "))
    if (result.code === 0) console.log("校验通过：" + result.files.length + " 个文件的 sha256 与 manifest 一致，封条一致。")
    process.exit(result.code)
  }
  if (!flags.input || flags.input === true) {
    console.error("usage: agentgate pack --input tools.txt [--index data/index.json] [--framework aicaiq] [--archive dir] [--calls calls.jsonl] [--out agentgate-pack]")
    process.exit(3)
  }
  const frameworkId = flags.framework === undefined || flags.framework === true ? "aicaiq" : String(flags.framework)
  let framework
  try { framework = frameworkById(frameworkId) } catch (error) { console.error("pack: " + error.message); process.exit(3) }
  let entries
  try { entries = parseInventory(readFileSync(String(flags.input), "utf8")) } catch (error) { console.error("pack: " + error.message); process.exit(2) }
  // An explicit --index is a decision, not a preference: falling back to the packaged sample
  // would build a customer-facing pack out of a demonstration index.
  const explicit = flags.index || process.env.AGENTGATE_INDEX || null
  const chosen = explicit ? { path: resolve(String(explicit)), why: "chosen" } : resolveIndex(flags)
  if (!existsSync(chosen.path)) { console.error("pack: 找不到证据索引 " + chosen.path + "；先跑 agentgate refresh，或用 --index 指定。"); process.exit(2) }
  if (String(chosen.path).indexOf("sample-index.json") !== -1) {
    console.error("pack: 用的是随包发布的历史样本索引，不是线上采集结果；它的数字只能当演示，别交给客户。")
  }
  let index
  try { index = JSON.parse(readFileSync(chosen.path, "utf8")) } catch (error) { console.error("pack: 索引读不了或解析不了：" + error.message); process.exit(2) }
  const generatedAt = new Date().toISOString()
  const report = createInventoryReport(entries, index, { generatedAt: generatedAt })
  let archive = null
  if (flags.archive && flags.archive !== true) {
    const dir = resolve(String(flags.archive))
    let verification = { problems: [{ detail: "归档不存在" }] }
    try { verification = verifyWatch(dir) } catch (error) { verification = { problems: [{ detail: error.message }] } }
    let history = []
    try { history = readWatch(dir) } catch (error) { history = [] }
    archive = { present: existsSync(dir), verified: verification.problems.length === 0, entries: history }
  }
  let calls = null
  if (flags.calls && flags.calls !== true) {
    try {
      const lines = readFileSync(String(flags.calls), "utf8").split(/\r?\n/).filter(function (line) { return line.trim().length > 0 })
      const decisions = lines.map(line => JSON.parse(line)).filter(entry => entry && entry.direction === "client" && entry.method === "tools/call" && typeof entry.tool === "string" && entry.tool.length > 0 && ["allowed", "refused"].includes(entry.decision) && Number.isFinite(Date.parse(entry.at)))
      calls = { provided: true, parsed: true, count: lines.length, decisionCount: decisions.length }
    } catch (error) { calls = { provided: true, parsed: false, count: 0 } }
  }
  let pack
  try {
    pack = buildPack({ report: report, framework: framework, archive: archive, calls: calls, generatedAt: generatedAt, toolVersion: VERSION })
  } catch (error) { console.error("pack: " + error.message); process.exit(2) }
  const command = "agentgate pack --input " + basename(String(flags.input)) + " --framework " + frameworkId +
    (archive ? " --archive <dir>" : "") + (calls ? " --calls <file>" : "")
  let written
  try { written = writePack(flags.out ? String(flags.out) : "agentgate-pack", pack, { command: command }) }
  catch (error) { console.error("pack: " + error.message); process.exit(3) }
  const q = pack.coverage.questions
  console.log("证据包已生成：" + written.dir)
  console.log("  清单 " + pack.coverage.items.total + " 项：与证据对应 " + pack.coverage.items.matched + " 项，需要处理 " + pack.coverage.items.needsAttention + " 项。")
  console.log("  " + framework.name + " " + q.total + " 条：我们出证据 " + q.ours + "（测到 " + q.measured + "、部分测到 " + q.partial + "、没测到 " + q.unmeasured + "），不是我们 " + q.notOurs + "。")
  console.log("  文件：" + written.files.join("、") + "（manifest.txt 上有逐个 sha256，manifest.sha256 是封条）")
  console.log("  复核：agentgate pack --verify " + written.dir)
  const medium = ["medium", "high", "critical"]
  const risk = report.items.some(function (entry) { return (entry.findings || []).some(function (finding) { return medium.indexOf(String(finding.severity)) !== -1 }) })
  if (q.partial + q.unmeasured > 0) {
    console.error("有 " + (q.partial + q.unmeasured) + " 条我们声称能给的答案没有完全测到；未测到不等于没有问题，这份包不会退出 0。")
    process.exitCode = 2
  } else if (risk) {
    console.error("清单里有 medium 及以上的发现，逐条列在 pack.html 里。")
    process.exitCode = 1
  } else process.exitCode = 0
}

// Help is side-effect free even for commands that normally collect data or start services.
if (args.flags.help) args.command = "help"
if (args.command === "inventory") inventory(args.flags)
else if (args.command === "pack") packCommand(args.flags)
else if (args.command === "discover") discoverCommand(args.flags)
else if (args.command === "audit") audit(args.flags)
else if (args.command === "watch") watchCommand(args.flags).catch(function (error) { console.error("watch: " + error.message); process.exit(3) })
else if (args.command === "framework") framework(args.flags).catch(function (error) { console.error("watch: " + error.message); process.exit(3) })
else if (args.command === "check") check(args.flags)
else if (args.command === "mcp") mcp(args.flags)
else if (args.command === "proxy") proxy(args.flags, args.rest)
else if (args.command === "diff") diff(args.flags)
else if (args.command === "serve") serve(args.flags)
else if (args.command === "refresh") refresh(args.flags)
else if (args.command === "history") history(args.flags)
else if (args.command === "version") console.log("agentgate " + VERSION)
else {
  console.log("agentgate <command>")
  console.log("")
  console.log("  discover  [--home <dir>] [--roots a,b] [--format text|json|inventory] [--out report.txt]   read the MCP configs already on this machine")
  console.log("  inventory --input tools.txt [--index data/index.json] [--framework aicaiq] [--format html|json] [--out report.html]")
  console.log("  framework [--id aicaiq] [--format text|json] [--out file]   who answers which questionnaire item")
  console.log("  check     --policy policy.json [--root .] [--index data/index.json] [--format console|sarif|json|html] [--lang zh-CN|en] [--out file]")
  console.log("  audit     --roots a,b,c [--policy p.json] [--index data/index.json] [--fail-on medium] [--format text|json]")
  console.log("  pack      --input tools.txt [--index data/index.json] [--framework aicaiq] [--archive dir] [--calls calls.jsonl] [--out agentgate-pack]")
  console.log("            --verify <dir>   重算 sha256 与封条，任何一个字节被改就非零退出")
  console.log("  watch     --input tools.txt [--archive dir] [--index data/index.json] [--webhook URL] [--webhook-format raw|wecom|feishu|slack]")
  console.log("            --verify [--archive dir]")
  console.log("  diff      --from old-index.json --to new-index.json [--format json|md] [--out file]")
  console.log("  mcp       [--index data/index.json]   serve the evidence as MCP tools over stdio (read-only)")
  console.log("  proxy     --policy policy.json [--log calls.jsonl] -- <server command> [args...]")
  console.log("  serve     [--port 8080] [--host 127.0.0.1] [--index path] [--sample path]")
  console.log("  refresh   [--max 300] [--repositories]   fetch public sources and rebuild data/index.json")
  console.log("            --repositories   also run the slower half: an incremental GitHub census and classification,")
  console.log("                             merged into the index as records counted apart from the registry")
  console.log("  history   [--history data/history] [--backfill] [--max-age 26] [--format json]   verify the chained capture ledger")
  console.log("  version")
}
