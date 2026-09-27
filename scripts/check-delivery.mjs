#!/usr/bin/env node
// Runs the same buyer-facing failure cases against a package directory or a source checkout.
// Inputs are synthetic; this does not measure customer coverage, accuracy, or time saved.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const [rootArg, label, output] = process.argv.slice(2)
if (!rootArg || !label || !output) {
  console.error('usage: node check-delivery.mjs <package-root> <label> <new-result.json>')
  process.exit(2)
}
const root = resolve(rootArg)
const scratch = mkdtempSync(join(tmpdir(), 'agentgate-delivery-fixtures-'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const moduleAt = relative => import(pathToFileURL(join(root, relative)).href)
const discovery = await moduleAt('packages/guard/src/discover.mjs')
const inventory = await moduleAt('packages/inventory/src/inventory.mjs')
const watch = await moduleAt('packages/watch/src/watch.mjs')
const { normalizePolicy } = await moduleAt('packages/policy/src/policy.mjs')
const { evaluate } = await moduleAt('packages/policy/src/evaluate.mjs')
const { executionFromBlocks } = await moduleAt('packages/collect/src/execution.mjs')
const checks = []
const input = (path, text) => { writeFileSync(path, text, { flag: 'wx' }); return path }
const dir = name => { const path = join(scratch, name); mkdirSync(path); return path }
const noNetwork = input(join(scratch, 'no-network.cjs'), `
const deny = () => { throw new Error('network disabled for delivery acceptance') }
globalThis.fetch = deny
for (const name of ['node:http', 'node:https']) {
  const mod = require(name); mod.request = deny; mod.get = deny
}
const net = require('node:net'); net.connect = deny; net.createConnection = deny
const tls = require('node:tls'); tls.connect = deny
`)
const run = args => {
  const result = spawnSync(process.execPath, ['--require', noNetwork, join(root, 'bin/agentgate.mjs'), ...args], {
    cwd: scratch, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, AGENTGATE_INDEX: '', NO_COLOR: '1' },
  })
  if (result.error) throw result.error
  let json = null
  try { json = JSON.parse(result.stdout) } catch {}
  return { code: result.status, json, stderr: result.stderr }
}
const add = (id, question, expected, action) => {
  try { checks.push({ id, question, expected, ...action() }) }
  catch (error) { checks.push({ id, question, expected, passed: false, error: error.message }) }
}

const project = dir('project')
input(join(project, 'package.json'), JSON.stringify({ name: 'delivery-fixture', version: '1.0.0' }))
const policyPath = input(join(scratch, 'policy.json'), JSON.stringify({ required: { measuredEvidence: ['packageManifest'] } }))
const checkArgs = ['check', '--root', project, '--policy', policyPath, '--format', 'json']

add('missing-explicit-index', '证据文件不存在时，是否阻止准入？', '退出 3；不能返回 clean', () => {
  const result = run([...checkArgs, '--index', join(scratch, 'absent-index.json')])
  return { passed: result.code === 3, observed: { exitCode: result.code, verdict: result.json?.verdict ?? null } }
})
add('required-evidence-absent', '没有提供必需证据时，是否明确未完成？', '退出 2；判定 incomplete', () => {
  const result = run(checkArgs)
  return { passed: result.code === 2 && result.json?.verdict === 'incomplete', observed: { exitCode: result.code, verdict: result.json?.verdict ?? null } }
})

function record(severity = null) {
  const packages = [{ registry: 'npm', name: 'delivery-fixture', version: '1.0.0' }]
  const evidence = { packageManifest: {
    status: severity ? 'findings' : 'clean', source: 'synthetic delivery acceptance fixture',
    findings: severity ? [{ rule: 'FIXTURE-RISK', severity, message: 'synthetic fixture only' }] : [],
    provenance: { package: packages[0], complete: true,
      content: { algorithm: 'sha256', digest: 'a'.repeat(64), scope: 'synthetic fixture only' } },
  } }
  return { server: 'fixture/delivery', packages, verdict: severity ? 'findings' : 'clean', evidence,
    scanExecution: executionFromBlocks({ server: 'fixture/delivery', packages, blocks: evidence }) }
}
add('valid-required-evidence', '证据确实对应且检查完整时，能否正常通过？', '退出 0；判定 clean', () => {
  const indexPath = input(join(scratch, 'valid-index.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), scanner: 'synthetic-delivery-acceptance', records: [record()],
  }))
  const result = run([...checkArgs, '--index', indexPath])
  return { passed: result.code === 0 && result.json?.verdict === 'clean', observed: { exitCode: result.code, verdict: result.json?.verdict ?? null } }
})
add('stricter-policy', '增加一项必需检查后，会不会把未完成变成通过？', '收紧前后均为 incomplete', () => {
  const r = record()
  r.scanExecution.scanner_execution.state = 'incomplete'
  r.scanExecution.scanner_execution.components.push({ id: 'source', required: true, status: 'failed' })
  const before = evaluate({ policy: normalizePolicy({ required: {} }), records: [r] }).verdict
  const after = evaluate({ policy: normalizePolicy({ required: { scanners: ['packageManifest'] } }), records: [r] }).verdict
  return { passed: before === 'incomplete' && after === 'incomplete', observed: { before, after } }
})
function discoverFiles(files, options) {
  return discovery.discover({ platform: 'linux', home: null, roots: [], ...options,
    exists: path => Object.hasOwn(files, path), readFile: path => files[path] })
}
add('same-alias-two-tools', '多个项目使用同一个别名时，是否遗漏不同工具？', '保留两项工具，并提示冲突', () => {
  const report = discoverFiles({
    '/fixture/a/.mcp.json': JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['files-a@1.0.0'] } } }),
    '/fixture/b/.mcp.json': JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['files-b@2.0.0'] } } }),
  }, { roots: ['/fixture/a', '/fixture/b'] })
  return { passed: report.servers.length === 2 && report.incomplete === true,
    observed: { configuredRecords: report.records.length, exportedServers: report.servers.length, incomplete: report.incomplete } }
})
add('python-identity', 'Python 工具导入报告后，是否仍保留正确生态和版本？', 'pypi / delivery-fetch / 1.2.3', () => {
  const report = discoverFiles({ '/fixture/a/.mcp.json': JSON.stringify({ mcpServers: {
    fetch: { command: 'uvx', args: ['delivery-fetch==1.2.3'] },
  } }) }, { roots: ['/fixture/a'] })
  const [entry] = inventory.parseInventory(discovery.renderText(report))
  return { passed: entry?.registry === 'pypi' && entry?.package === 'delivery-fetch' && entry?.version === '1.2.3',
    observed: { registry: entry?.registry, package: entry?.package, version: entry?.version } }
})
add('same-count-risk-change', '发现数量不变但风险加重时，能否发出变更？', '识别一项变化；保留可验证归档', () => {
  const archive = dir('watch')
  const entries = inventory.parseInventory('delivery-fixture@1.0.0')
  const makeReport = severity => inventory.createInventoryReport(entries, {
    scanner: 'synthetic-delivery-acceptance', generatedAt: new Date().toISOString(), records: [record(severity)],
  })
  const before = watch.appendWatch(archive, { entries, report: makeReport('low') })
  const after = watch.appendWatch(archive, { entries, report: makeReport('critical') })
  const verified = watch.verifyWatch(archive).ok
  return { passed: after.diff.changed.length === 1 && verified,
    observed: { changed: after.diff.changed.length, digestChanged: before.entry.reportDigest !== after.entry.reportDigest, archiveVerified: verified } }
})
add('codex-config', 'Codex 配置能否读取，并将禁用工具排除出清单？', '读到两项配置，仅导出一项启用或未明确禁用工具', () => {
  const report = discoverFiles({ '/fixture/home/.codex/config.toml':
    '[mcp_servers.active]\ncommand="npx"\nargs=["delivery-tool@1.2.3"]\n[mcp_servers.off]\nenabled=false\ncommand="npx"\nargs=["delivery-off@2.0.0"]\n',
  }, { home: '/fixture/home' })
  const exported = inventory.parseInventory(discovery.renderText(report))
  return { passed: report.counts.sourcesRead === 1 && report.servers.length === 2 && exported.length === 1 && exported[0]?.package === 'delivery-tool',
    observed: { sourcesRead: report.counts.sourcesRead, configuredServers: report.servers.length, exported: exported.length, incomplete: report.incomplete } }
})
add('discovery-credential-boundary', '发现工具时，是否避免将凭据参数带入交付物？', '清单含包名和版本，不含合成凭据值', () => {
  const secret = 'SYNTHETIC_SECRET_NOT_A_REAL_CREDENTIAL'
  const report = discoverFiles({ '/fixture/a/.mcp.json': JSON.stringify({ mcpServers: {
    fixture: { command: 'npx', args: ['delivery-tool@1.2.3', '--token', secret], env: { TOKEN: secret } },
  } }) }, { roots: ['/fixture/a'] })
  const rendered = discovery.renderText(report)
  return { passed: !rendered.includes(secret) && rendered.includes('delivery-tool'), observed: { credentialExposed: rendered.includes(secret), identityPresent: rendered.includes('delivery-tool') } }
})

const sourceFiles = ['bin/agentgate.mjs', 'packages/guard/src/discover.mjs', 'packages/policy/src/evaluate.mjs', 'packages/inventory/src/inventory.mjs', 'packages/watch/src/watch.mjs']
const result = {
  kind: 'internal-delivery-acceptance', generatedAt: new Date().toISOString(), label,
  package: { name: pkg.name, version: pkg.version, root }, runtime: { node: process.version, platform: process.platform, arch: process.arch },
  boundary: 'Synthetic failure scenarios against actual package code. Not enterprise coverage, customer acceptance, independent security certification, or a measurement of time saved.',
  sourceDigests: Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
  summary: { checks: checks.length, passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length },
  checks, scratch,
}
writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ label, packageVersion: pkg.version, summary: result.summary, checks: checks.map(c => ({ id: c.id, passed: c.passed, observed: c.observed, error: c.error })), result: resolve(output) }, null, 2))
process.exitCode = result.summary.failed ? 1 : 0
