#!/usr/bin/env node
// Runs the same buyer-facing failure cases against a package directory or a source checkout.
// Inputs are synthetic; this does not measure customer coverage, accuracy, or time saved.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createProgressJournal } from '../packages/release/src/progress.mjs'

const [rootArg, label, output] = process.argv.slice(2)
if (!rootArg || !label || !output) {
  console.error('usage: node check-delivery.mjs <package-root> <label> <new-result.json>')
  process.exit(2)
}
const root = resolve(rootArg)
const progress = createProgressJournal(resolve(output) + '.progress.jsonl', [
  'load-package', 'missing-explicit-index', 'required-evidence-absent', 'valid-required-evidence',
  'stricter-policy', 'same-alias-two-tools', 'python-identity', 'same-count-risk-change', 'codex-config',
  'discovery-credential-boundary', 'cli-discovery-inventory-handoff', 'cli-inventory-json-readback',
  'cli-inventory-html-readback', 'cli-default-sample-not-confirmed', 'cli-output-no-implicit-overwrite',
  'cli-invalid-source-stays-incomplete', 'cli-windows-launcher-declarations',
  'cli-leading-option-values-stay-private', 'cli-credential-boundary-end-to-end',
  'cli-inventory-file-encodings', 'cli-inventory-raw-config-refusal',
])
progress('load-package', 'started')
const scratch = mkdtempSync(join(tmpdir(), 'agentgate-delivery-fixtures-'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const moduleAt = relative => import(pathToFileURL(join(root, relative)).href)
const discovery = await moduleAt('packages/guard/src/discover.mjs')
const inventory = await moduleAt('packages/inventory/src/inventory.mjs')
const watch = await moduleAt('packages/watch/src/watch.mjs')
const { normalizePolicy } = await moduleAt('packages/policy/src/policy.mjs')
const { evaluate } = await moduleAt('packages/policy/src/evaluate.mjs')
const { executionFromBlocks } = await moduleAt('packages/collect/src/execution.mjs')
progress('load-package', 'passed')
let currentCheck
const checks = []
const input = (path, text) => { writeFileSync(path, text, { flag: 'wx' }); return path }
const dir = name => { const path = join(scratch, name); mkdirSync(path); return path }
// Never inherit the operator's home or credential-bearing environment into a CLI check.
const cliHome = dir('cli-home')
const cliTemp = dir('cli-temp')
const cliEnv = { PATH: process.env.PATH, HOME: cliHome, USERPROFILE: cliHome,
  APPDATA: cliHome, LOCALAPPDATA: cliHome, TMPDIR: cliTemp, TMP: cliTemp, TEMP: cliTemp,
  AGENTGATE_INDEX: '', NO_COLOR: '1' }
for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive']) {
  if (process.env[key] !== undefined) cliEnv[key] = process.env[key]
}
const noNetwork = input(join(scratch, 'no-network.cjs'), `
const deny = () => { throw new Error('network disabled for delivery acceptance') }
globalThis.fetch = deny
for (const name of ['node:http', 'node:https']) {
  const mod = require(name); mod.request = deny; mod.get = deny
}
const net = require('node:net'); net.connect = deny; net.createConnection = deny
net.Socket.prototype.connect = deny
const tls = require('node:tls'); tls.connect = deny
const dns = require('node:dns'); dns.lookup = deny; dns.resolve = deny
dns.promises.lookup = deny; dns.promises.resolve = deny
require('node:module').syncBuiltinESMExports()
`)
const run = args => {
  progress(currentCheck, 'command-started')
  const result = spawnSync(process.execPath, ['--require', noNetwork, join(root, 'bin/agentgate.mjs'), ...args], {
    cwd: scratch, encoding: 'utf8', timeout: 15000,
    env: cliEnv,
  })
  if (result.error) {
    progress(currentCheck, 'command-failed')
    throw result.error
  }
  progress(currentCheck, 'command-finished')
  let json = null
  try { json = JSON.parse(result.stdout) } catch {}
  return { code: result.status, json, stdout: result.stdout, stderr: result.stderr }
}
const add = (id, question, expected, action) => {
  currentCheck = id
  progress(id, 'started')
  try { checks.push({ id, question, expected, ...action() }) }
  catch (error) { checks.push({ id, question, expected, passed: false, error: error.message }) }
  progress(id, checks.at(-1).passed ? 'passed' : 'failed')
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
// These sources exist only in the map above. Use the same host path semantics as
// candidateSources; selecting a client platform does not change node:path.join.
const virtualProjectA = join(scratch, 'virtual', 'a')
const virtualProjectB = join(scratch, 'virtual', 'b')
const virtualHome = join(scratch, 'virtual', 'home')
add('same-alias-two-tools', '多个项目使用同一个别名时，是否遗漏不同工具？', '保留两项工具，并提示冲突', () => {
  const report = discoverFiles({
    [join(virtualProjectA, '.mcp.json')]: JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['files-a@1.0.0'] } } }),
    [join(virtualProjectB, '.mcp.json')]: JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['files-b@2.0.0'] } } }),
  }, { roots: [virtualProjectA, virtualProjectB] })
  return { passed: report.servers.length === 2 && report.incomplete === true,
    observed: { configuredRecords: report.records.length, exportedServers: report.servers.length, incomplete: report.incomplete } }
})
add('python-identity', 'Python 工具导入报告后，是否仍保留正确生态和版本？', 'pypi / delivery-fetch / 1.2.3', () => {
  const report = discoverFiles({ [join(virtualProjectA, '.mcp.json')]: JSON.stringify({ mcpServers: {
    fetch: { command: 'uvx', args: ['delivery-fetch==1.2.3'] },
  } }) }, { roots: [virtualProjectA] })
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
  const report = discoverFiles({ [join(virtualHome, '.codex', 'config.toml')]:
    '[mcp_servers.active]\ncommand="npx"\nargs=["delivery-tool@1.2.3"]\n[mcp_servers.off]\nenabled=false\ncommand="npx"\nargs=["delivery-off@2.0.0"]\n',
  }, { home: virtualHome })
  const exported = inventory.parseInventory(discovery.renderText(report))
  return { passed: report.counts.sourcesRead === 1 && report.servers.length === 2 && exported.length === 1 && exported[0]?.package === 'delivery-tool',
    observed: { sourcesRead: report.counts.sourcesRead, configuredServers: report.servers.length, exported: exported.length, incomplete: report.incomplete } }
})
add('discovery-credential-boundary', '发现工具时，是否避免将凭据参数带入交付物？', '清单含包名和版本，不含合成凭据值', () => {
  const secret = 'SYNTHETIC_SECRET_NOT_A_REAL_CREDENTIAL'
  const report = discoverFiles({ [join(virtualProjectA, '.mcp.json')]: JSON.stringify({ mcpServers: {
    fixture: { command: 'npx', args: ['delivery-tool@1.2.3', '--token', secret], env: { TOKEN: secret } },
  } }) }, { roots: [virtualProjectA] })
  const rendered = discovery.renderText(report)
  return { passed: !rendered.includes(secret) && rendered.includes('delivery-tool'), observed: { credentialExposed: rendered.includes(secret), identityPresent: rendered.includes('delivery-tool') } }
})

// The original checks above exercise policy and pure-module boundaries. These additional
// checks exercise the actual shipped CLI handoff, using only this synthetic home/project.
// The CLI currently has no language flag: its default Chinese HTML is checked here; English
// browser assets are a separate delivery gate, not a fictitious `inventory --lang` check.
const cliProject = dir('cli-project')
const credentialMarkers = [
  'SYNTHETIC_DELIVERY_CODEX_ARGUMENT', 'SYNTHETIC_DELIVERY_CODEX_ENVIRONMENT',
  'SYNTHETIC_DELIVERY_MCP_ENVIRONMENT', 'SYNTHETIC_DELIVERY_MCP_HEADER',
  'SYNTHETIC_DELIVERY_MCP_URL_TOKEN', 'SYNTHETIC_DELIVERY_UNSUPPORTED_MAP',
]
mkdirSync(join(cliHome, '.codex'))
const codexPath = input(join(cliHome, '.codex', 'config.toml'), [
  '[mcp_servers.npm_tool]', 'command = "npx"', 'enabled = true',
  'args = ["pretrip-mcp@1.0.1", "--token", "' + credentialMarkers[0] + '"]',
  '[mcp_servers.npm_tool.env]', 'TOKEN = "' + credentialMarkers[1] + '"',
  '[mcp_servers.codex_disabled]', 'command = "npx"', 'enabled = false',
  'args = ["delivery-disabled-codex@9.9.9"]', '',
].join('\n'))
const mcpPath = input(join(cliProject, '.mcp.json'), JSON.stringify({ mcpServers: {
  python_tool: { command: 'uvx', args: ['delivery-fetch==1.2.3'], env: { TOKEN: credentialMarkers[2] } },
  'opaque-tool@7.8.9': { command: '/synthetic-delivery/unresolved-tool',
    url: 'https://delivery-fixture.invalid/mcp?api_key=' + credentialMarkers[4],
    headers: { Authorization: 'Bearer ' + credentialMarkers[3] } },
  json_disabled: { enabled: false, command: 'npx', args: ['delivery-disabled-json@8.8.8'] },
} }))
const configBefore = [codexPath, mcpPath].map(path => readFileSync(path, 'utf8'))
const expectedTools = [
  { name: 'npm_tool', package: 'pretrip-mcp', registry: 'npm', version: '1.0.1' },
  { name: 'opaque-tool@7.8.9', package: null, registry: null, version: null },
  { name: 'python_tool', package: 'delivery-fetch', registry: 'pypi', version: '1.2.3' },
]
const identityFields = ['name', 'package', 'registry', 'version']
const identities = rows => Array.isArray(rows) ? rows.map(row =>
  Object.fromEntries(identityFields.map(key => [key, row?.[key]])),
).sort((a, b) => String(a.name).localeCompare(String(b.name))) : null
const identitiesMatch = rows => JSON.stringify(identities(rows)) === JSON.stringify(identities(expectedTools))
const delivery = { commands: [], artifacts: [] }
const deliveryRun = args => { const result = run(args); delivery.commands.push(result); return result }
const readArtifact = path => { const text = readFileSync(path, 'utf8'); delivery.artifacts.push(text); return text }
const toolsPath = join(scratch, 'cli-tools.json')
const jsonPath = join(scratch, 'cli-report.json')
const htmlPath = join(scratch, 'cli-report.html')
const discoverArgs = ['discover', '--home', cliHome, '--roots', cliProject]
const inventoryArgs = ['inventory', '--input', toolsPath]

add('cli-discovery-inventory-handoff', '真实 CLI 能否从隔离的 Codex 和 MCP 配置导出可交付清单？', '两份来源读全，五项配置中排除两项禁用工具，导出三项原始身份', () => {
  const diagnostic = deliveryRun([...discoverArgs, '--format', 'json'])
  const exported = deliveryRun([...discoverArgs, '--format', 'inventory', '--out', toolsPath])
  delivery.toolsText = readArtifact(toolsPath)
  delivery.tools = JSON.parse(delivery.toolsText).tools
  const counts = diagnostic.json?.counts
  const expectedSources = [codexPath, mcpPath].sort()
  const actualSources = diagnostic.json?.sources?.map(source => source.abs).sort()
  return {
    passed: diagnostic.code === 0 && exported.code === 0 && diagnostic.json?.incomplete === false &&
      JSON.stringify(actualSources) === JSON.stringify(expectedSources) && counts?.sourcesRead === 2 &&
      counts?.servers === 5 && counts?.serversDisabled === 2 && counts?.serversExported === 3 &&
      identitiesMatch(delivery.tools),
    observed: { diagnosticExit: diagnostic.code, exportExit: exported.code, sourcesRead: counts?.sourcesRead,
      configured: counts?.servers, disabled: counts?.serversDisabled, exported: delivery.tools?.length,
      identitiesPreserved: identitiesMatch(delivery.tools), incomplete: diagnostic.json?.incomplete },
  }
})
add('cli-inventory-json-readback', '发现输出能否直接交给 inventory 命令并保留未知身份？', 'JSON 报告读回三项；npm、pypi 的身份不变，未知别名不能变成猜测的包或版本', () => {
  const generated = deliveryRun([...inventoryArgs, '--format', 'json', '--out', jsonPath])
  delivery.jsonText = readArtifact(jsonPath)
  delivery.report = JSON.parse(delivery.jsonText)
  const rows = delivery.report.items?.map(item => item.input)
  return { passed: generated.code === 0 && delivery.report.summary?.total === expectedTools.length && identitiesMatch(rows),
    observed: { exitCode: generated.code, total: delivery.report.summary?.total,
      identitiesPreserved: identitiesMatch(rows), unknown: identities(rows)?.find(row => row.name === 'opaque-tool@7.8.9') } }
})
add('cli-inventory-html-readback', '默认 HTML 交付物能否离线读回完整工具清单？', '中文独立 HTML 含全部三项身份，无脚本或外部资源依赖', () => {
  const generated = deliveryRun([...inventoryArgs, '--out', htmlPath])
  delivery.htmlText = readArtifact(htmlPath)
  const identitiesPresent = expectedTools.every(tool => identityFields.every(field =>
    tool[field] === null || delivery.htmlText.includes(tool[field])))
  const standalone = !/<script\b/i.test(delivery.htmlText) && !/(?:src|href)=["']https?:/i.test(delivery.htmlText)
  const chinese = /<html lang="zh-CN">/.test(delivery.htmlText)
  return { passed: generated.code === 0 && chinese && identitiesPresent && standalone,
    observed: { exitCode: generated.code, language: chinese ? 'zh-CN' : null, identitiesPresent, standalone } }
})
add('cli-default-sample-not-confirmed', '未指定索引时，随包样本会不会冒充客户工具已核验？', '默认索引明确为样本，已知样本坐标仍为证据不足，零项 matched', () => {
  const report = delivery.report
  const known = report?.items?.find(item => item.input?.package === 'pretrip-mcp')
  const noMatched = Array.isArray(report?.items) && report.items.every(item => item.state !== 'matched')
  const sampleExplained = typeof known?.reason === 'string' && known.reason.includes('历史样本')
  return { passed: report?.index?.snapshot === true && report.summary?.matched === 0 && noMatched &&
      known?.state === 'insufficient' && sampleExplained && delivery.htmlText?.includes('样本历史快照'),
    observed: { snapshot: report?.index?.snapshot, matched: report?.summary?.matched,
      knownSampleState: known?.state, sampleExplained } }
})
add('cli-output-no-implicit-overwrite', '重复运行命令会不会悄悄覆盖已有清单、报告或源配置？', '重复发现退出 3，重复 JSON/HTML 报告退出 2；原文件逐字节不变；POSIX 输出权限为 0600，Windows 继承目录 ACL（本检查不证明 ACL 私密性）', () => {
  const attempts = [
    { path: toolsPath, args: [...discoverArgs, '--format', 'inventory', '--out', toolsPath], expected: 3 },
    { path: jsonPath, args: [...inventoryArgs, '--format', 'json', '--out', jsonPath], expected: 2 },
    { path: htmlPath, args: [...inventoryArgs, '--out', htmlPath], expected: 2 },
  ].map(attempt => {
    const before = readFileSync(attempt.path)
    const result = deliveryRun(attempt.args)
    return { exitCode: result.code, expectedExit: attempt.expected,
      unchanged: before.equals(readFileSync(attempt.path)), mode: statSync(attempt.path).mode & 0o777 }
  })
  const sourcesUnchanged = [codexPath, mcpPath].every((path, i) => readFileSync(path, 'utf8') === configBefore[i])
  const posixPermissions = process.platform !== 'win32'
  return { passed: attempts.every(attempt => attempt.exitCode === attempt.expectedExit && attempt.unchanged &&
      (!posixPermissions || attempt.mode === 0o600)) && sourcesUnchanged,
    observed: { attempts, sourcesUnchanged, permissions: posixPermissions
      ? { model: 'POSIX', requiredMode: '0600', verified: attempts.every(attempt => attempt.mode === 0o600) }
      : { model: 'Windows inherited ACL', verified: false, boundary: 'Use a private user directory; POSIX mode bits do not establish Windows ACL privacy.' } } }
})
add('cli-invalid-source-stays-incomplete', '一份 MCP JSON 结构无效时，会不会伪装成完整空清单或丢掉好来源？', '真实 CLI 退出 2，标记 unsupported-mcp-json 和 incomplete，并仍导出有效来源', () => {
  const partialRoot = dir('cli-partial-project')
  input(join(partialRoot, '.mcp.json'), JSON.stringify({ mcpServers: {
    partial_good: { command: 'npx', args: ['delivery-partial-good@2.3.4'] },
  } }))
  input(join(partialRoot, 'mcp.json'), JSON.stringify({ mcpServers: credentialMarkers[5] }))
  const args = ['discover', '--home', cliHome, '--roots', partialRoot]
  const diagnostic = deliveryRun([...args, '--format', 'json'])
  const partialPath = join(scratch, 'cli-partial-tools.json')
  const exported = deliveryRun([...args, '--format', 'inventory', '--out', partialPath])
  const tools = JSON.parse(readArtifact(partialPath)).tools
  const retained = tools?.some(tool => tool.name === 'partial_good' && tool.registry === 'npm' &&
    tool.package === 'delivery-partial-good' && tool.version === '2.3.4')
  const badSource = diagnostic.json?.sources?.find(source => source.abs === join(partialRoot, 'mcp.json'))
  return { passed: diagnostic.code === 2 && exported.code === 2 && diagnostic.json?.incomplete === true &&
      badSource?.status === 'unparsed' && badSource?.reason === 'unsupported-mcp-json' && retained,
    observed: { diagnosticExit: diagnostic.code, exportExit: exported.code, incomplete: diagnostic.json?.incomplete,
      sourceStatus: badSource?.status, sourceReason: badSource?.reason, validSourceRetained: retained } }
})
add('cli-windows-launcher-declarations', '配置使用 Windows 的 npx.cmd / uvx.exe 名称时，声明身份能否保留到报告？', '保留 npm / pypi 包和版本，排除禁用工具，命令包装器仍未知；不是原生 Windows 执行验证', () => {
  const home = dir('windows-declaration-home')
  const project = dir('windows-declaration-project')
  const secret = 'SYNTHETIC_WINDOWS_DECLARATION_SECRET'
  credentialMarkers.push(secret)
  const configPath = input(join(project, '.mcp.json'), JSON.stringify({ mcpServers: {
    npm_tool: { command: 'C:\\Program Files\\nodejs\\NPX.CMD', args: ['--yes', 'pretrip-mcp@1.0.1', '--token', secret], env: { TOKEN: secret } },
    python_tool: { command: 'C:\\Users\\Synthetic\\bin\\uvx.exe', args: ['delivery-fetch==1.2.3', '--key', secret] },
    'opaque-tool@7.8.9': { command: 'cmd.exe', args: ['/c', 'npx.cmd', 'do-not-infer@9.9.9', secret] },
    disabled: { command: 'npx.cmd', args: ['disabled-windows-tool@9.9.9'], enabled: false },
  } }))
  const before = readFileSync(configPath)
  const args = ['discover', '--home', home, '--roots', project]
  const diagnostic = deliveryRun([...args, '--format', 'json'])
  const toolsPath = join(scratch, 'windows-declaration-tools.json')
  const exported = deliveryRun([...args, '--format', 'inventory', '--out', toolsPath])
  const tools = JSON.parse(readArtifact(toolsPath)).tools
  const reportPath = join(scratch, 'windows-declaration-report.json')
  const generated = deliveryRun(['inventory', '--input', toolsPath, '--format', 'json', '--out', reportPath])
  const report = JSON.parse(readArtifact(reportPath))
  const counts = diagnostic.json?.counts
  const identitiesPreserved = identitiesMatch(tools) && identitiesMatch(report.items?.map(item => item.input))
  const inventoryFieldsRestricted = Array.isArray(tools) && tools.every(tool => Object.keys(tool).every(key => identityFields.includes(key)))
  const sourceUnchanged = before.equals(readFileSync(configPath))
  return { passed: diagnostic.code === 0 && exported.code === 0 && generated.code === 0 &&
      counts?.sourcesRead === 1 && counts?.servers === 4 && counts?.serversDisabled === 1 &&
      counts?.serversExported === 3 && counts?.exportedPackagesUnknown === 1 && counts?.exportedVersionsUnknown === 1 &&
      diagnostic.json?.incomplete === false && identitiesPreserved && inventoryFieldsRestricted && sourceUnchanged,
    observed: { diagnosticExit: diagnostic.code, exportExit: exported.code, inventoryExit: generated.code,
      sourcesRead: counts?.sourcesRead, configured: counts?.servers, disabled: counts?.serversDisabled,
      exported: tools?.length, unknownPackages: counts?.exportedPackagesUnknown, unknownVersions: counts?.exportedVersionsUnknown,
      identitiesPreserved, inventoryFieldsRestricted, sourceUnchanged, nativeWindowsExecution: false } }
})
add('cli-leading-option-values-stay-private', '启动器的前导选项值会不会被猜成包名并进入报告？', '无法确定的命令保留未知身份，合成选项值不进入诊断、清单或 JSON/HTML 报告', () => {
  const home = dir('option-boundary-home')
  const project = dir('option-boundary-project')
  const secret = 'SYNTHETIC_PRIVATE_OPTION_VALUE'
  credentialMarkers.push(secret)
  const entries = {
    npm_cache: { command: 'npx', args: ['--cache', secret, 'delivery-tool@1.2.3'] },
    windows_node_options: { command: 'npx.cmd', args: ['--node-options', secret, 'delivery-tool@1.2.3'] },
    python_index: { command: 'uvx', args: ['--index-url', secret, 'delivery-fetch==1.2.3'] },
    windows_from: { command: 'uvx.exe', args: ['--from', secret + '==9.8.7', 'delivery-fetch'] },
    npm_package: { command: 'npx', args: ['-p', secret + '@9.8.7', 'delivery-tool'] },
    malformed_args: { command: 'npx', args: [null, secret, 'delivery-tool@1.2.3'] },
  }
  const expected = Object.keys(entries).map(name => ({ name, package: null, registry: null, version: null }))
  const configPath = input(join(project, '.mcp.json'), JSON.stringify({ mcpServers: entries }))
  const before = readFileSync(configPath)
  const args = ['discover', '--home', home, '--roots', project]
  const diagnostic = deliveryRun([...args, '--format', 'json'])
  const toolsPath = join(scratch, 'option-boundary-tools.json')
  const exported = deliveryRun([...args, '--format', 'inventory', '--out', toolsPath])
  const toolsText = readArtifact(toolsPath)
  const tools = JSON.parse(toolsText).tools
  const jsonPath = join(scratch, 'option-boundary-report.json')
  const generated = deliveryRun(['inventory', '--input', toolsPath, '--format', 'json', '--out', jsonPath])
  const jsonText = readArtifact(jsonPath)
  const report = JSON.parse(jsonText)
  const htmlPath = join(scratch, 'option-boundary-report.html')
  const html = deliveryRun(['inventory', '--input', toolsPath, '--out', htmlPath])
  const htmlText = readArtifact(htmlPath)
  const rows = report.items?.map(item => item.input)
  const expectedJson = JSON.stringify(identities(expected))
  const unknownsPreserved = JSON.stringify(identities(tools)) === expectedJson && JSON.stringify(identities(rows)) === expectedJson
  const inventoryFieldsRestricted = Array.isArray(tools) && tools.every(tool => Object.keys(tool).every(key => identityFields.includes(key)))
  const htmlAliasesPresent = expected.every(tool => htmlText.includes(tool.name))
  const outputs = [diagnostic, exported, generated, html].flatMap(result => [result.stdout, result.stderr]).concat(toolsText, jsonText, htmlText)
  const exposedOutputs = outputs.filter(text => text.includes(secret)).length
  const sourceUnchanged = before.equals(readFileSync(configPath))
  const counts = diagnostic.json?.counts
  return { passed: [diagnostic, exported, generated, html].every(result => result.code === 0) &&
      counts?.sourcesRead === 1 && counts?.serversExported === expected.length &&
      counts?.exportedPackagesUnknown === expected.length && counts?.exportedVersionsUnknown === expected.length &&
      report.summary?.total === expected.length && unknownsPreserved && inventoryFieldsRestricted && htmlAliasesPresent && exposedOutputs === 0 && sourceUnchanged,
    observed: { diagnosticExit: diagnostic.code, exportExit: exported.code, inventoryExit: generated.code, htmlExit: html.code,
      exported: tools?.length, unknownPackages: counts?.exportedPackagesUnknown, unknownVersions: counts?.exportedVersionsUnknown,
      unknownsPreserved, inventoryFieldsRestricted, htmlAliasesPresent, exposedOutputs, sourceUnchanged } }
})
add('cli-credential-boundary-end-to-end', '真实 CLI 的所有交付物和诊断会不会带出配置中的合成凭据？', '参数、环境变量、请求头和 URL 中的合成值均不出现在标准输出、错误输出或生成文件里', () => {
  const outputs = delivery.commands.flatMap(command => [command.stdout, command.stderr]).concat(delivery.artifacts)
  const leaks = outputs.filter(text => typeof text === 'string' && credentialMarkers.some(marker => text.includes(marker)))
  const narrowFields = Array.isArray(delivery.tools) && delivery.tools.every(tool =>
    Object.keys(tool).every(key => identityFields.includes(key)))
  return { passed: delivery.tools?.length === expectedTools.length && delivery.artifacts.length >= 4 &&
      outputs.every(text => typeof text === 'string') && leaks.length === 0 && narrowFields,
    observed: { commandsChecked: delivery.commands.length, artifactsChecked: delivery.artifacts.length,
      exposedOutputs: leaks.length, inventoryFieldsRestricted: narrowFields } }
})

const encodeInventory = (text, encoding) => {
  if (encoding === 'utf8') return Buffer.from(text)
  const bytes = Buffer.from(text, 'utf16le')
  return encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), bytes])
    : Buffer.concat([Buffer.from([0xfe, 0xff]), bytes.swap16()])
}
add('cli-inventory-file-encodings', '安装包能否读取不同文本编码的正常清单？', 'UTF-8、带 BOM 的 UTF-16LE/BE 的文本和 JSON 清单均生成两项报告，身份不损坏', () => {
  const attempts = []
  for (const encoding of ['utf8', 'utf16le', 'utf16be']) for (const format of ['txt', 'json']) {
    const text = format === 'json' ? JSON.stringify({ tools: [{ name: 'encoding-fixture' }, { name: '工具-未知' }] })
      : 'encoding-fixture\r\n工具-未知\r\n'
    const source = input(join(scratch, `encoding-${encoding}.${format}`), encodeInventory(text, encoding))
    const before = readFileSync(source)
    const target = join(scratch, `encoding-${encoding}-${format}-report.json`)
    const command = run(['inventory', '--input', source, '--format', 'json', '--out', target])
    const report = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : null
    attempts.push({ encoding, format, exitCode: command.code, total: report?.summary?.total,
      identitiesPreserved: JSON.stringify(report?.items?.map(item => item.input?.name)) === JSON.stringify(['encoding-fixture', '工具-未知']),
      sourceUnchanged: before.equals(readFileSync(source)) })
  }
  return { passed: attempts.every(item => item.exitCode === 0 && item.total === 2 && item.identitiesPreserved && item.sourceUnchanged), observed: { attempts } }
})
add('cli-inventory-raw-config-refusal', '原始配置或损坏文件会不会伪装成清单进入报告？', '拒绝不同编码的 MCP 配置、带前导字段的 Codex 配置、JSON 标量、控制字符和损坏编码，不输出合成私密值', () => {
  const marker = 'SYNTHETIC_REJECTED_IMPORT_VALUE'
  const config = JSON.stringify({ mcpServers: { fixture: { command: 'node', env: { TOKEN: marker } } } }, null, 2)
  const fixtures = [
    ...['utf8', 'utf16le', 'utf16be'].map(encoding => ({ name: `raw-${encoding}.json`, bytes: encodeInventory(config, encoding) })),
    { name: 'renamed-codex.txt', bytes: Buffer.from('model = "fixture"\n[mcp_servers.fixture]\ncommand = "node"\nenv = { TOKEN = "' + marker + '" }') },
    { name: 'scalar.json', bytes: Buffer.from('"' + marker + '"') },
    { name: 'escaped-control.json', bytes: Buffer.from(JSON.stringify([{ name: 'bad\u0000' + marker }])) },
    { name: 'broken.txt', bytes: Buffer.from([0xc3, 0x28]) },
  ]
  const attempts = fixtures.map(fixture => {
    const source = input(join(scratch, fixture.name), fixture.bytes)
    const target = join(scratch, fixture.name + '-refused.html')
    const command = run(['inventory', '--input', source, '--out', target])
    return { name: fixture.name, exitCode: command.code, reportCreated: existsSync(target),
      diagnosticExposedValue: (command.stdout + command.stderr).includes(marker), sourceUnchanged: fixture.bytes.equals(readFileSync(source)) }
  })
  return { passed: attempts.every(item => item.exitCode === 2 && !item.reportCreated && !item.diagnosticExposedValue && item.sourceUnchanged), observed: { attempts } }
})

const sourceFiles = ['bin/agentgate.mjs', 'packages/guard/src/discover.mjs', 'packages/guard/src/codex-toml.mjs', 'packages/guard/src/known-configs.mjs', 'packages/policy/src/evaluate.mjs', 'packages/inventory/src/inventory.mjs', 'packages/inventory/src/report.mjs', 'packages/watch/src/watch.mjs']
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
