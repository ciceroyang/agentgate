/** Pure inventory parsing and evidence matching; no filesystem, network or execution. */
const MAX_BYTES = 1024 * 1024
const MAX_ENTRIES = 500
const INPUT_FIELDS = ['name', 'server', 'package', 'registry', 'version']
const DOCUMENT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
const FIELD_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
const LABELS_ZH = {
  matched: '版本与证据对应', unmatched: '当前索引未找到', ambiguous: '需要确认候选',
  version_missing: '需要你的精确版本', version_mismatch: '版本不一致', insufficient: '证据不足',
}
const LABELS_EN = {
  matched: 'Version and evidence matched', unmatched: 'Not found in the current index', ambiguous: 'Candidate confirmation required',
  version_missing: 'Your exact version is required', version_mismatch: 'Version mismatch', insufficient: 'Insufficient evidence',
}
const LIMIT_ZH = '结论只覆盖列出的已检查材料，不代表整包、传递依赖或运行时安全。'
const LIMIT_EN = 'The result covers only the listed material that was checked; it does not represent the whole package, transitive dependencies, or runtime safety.'
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const textOrNull = (value) => typeof value === 'string' ? value : null
const own = (value, key) => object(value) && Object.hasOwn(value, key)
const npmName = (value) => typeof value === 'string' && /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/.test(value)

/** Decode only supported text encodings; never silently replace malformed input bytes. */
export function decodeInventoryFile(bytes, options = {}) {
  const msg = (zh, en) => options?.locale === 'en' ? en : zh
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
    throw new Error(msg('请提供 Uint8Array 或 ArrayBuffer 文件字节。', 'Provide file bytes as a Uint8Array or ArrayBuffer.'))
  }
  let view
  try { view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) }
  catch { throw new Error(msg('无法读取文件字节。', 'The file bytes cannot be read.')) }
  if (view.byteLength > MAX_BYTES) throw new Error(msg('清单不能超过 1 MB。', 'The inventory cannot exceed 1 MB.'))
  if ((view[0] === 0xff && view[1] === 0xfe && view[2] === 0 && view[3] === 0) ||
      (view[0] === 0 && view[1] === 0 && view[2] === 0xfe && view[3] === 0xff)) {
    throw new Error(msg('不支持 UTF-32 文件，请保存为 UTF-8 或带 BOM 的 UTF-16。', 'UTF-32 files are not supported. Save as UTF-8 or UTF-16 with a BOM.'))
  }
  const encoding = view[0] === 0xff && view[1] === 0xfe ? 'utf-16le'
    : view[0] === 0xfe && view[1] === 0xff ? 'utf-16be' : 'utf-8'
  try { return new TextDecoder(encoding, { fatal: true }).decode(view) }
  catch { throw new Error(msg('文件编码损坏或不受支持，请保存为 UTF-8 或带 BOM 的 UTF-16。', 'The file encoding is malformed or unsupported. Save as UTF-8 or UTF-16 with a BOM.')) }
}

function looksLikeLaunchConfig(text) {
  // Recognizable configuration syntax is not an inventory. This is deliberately not
  // a general secret detector: arbitrary tool names remain valid Unicode text.
  // A preamble or comment must not turn later JSON objects/arrays or TOML sections
  // into tool-name lines. Structured inventories must be valid JSON as a whole.
  return /^[^\S\r\n]*[\[{]/m.test(text) ||
    /^[^\S\r\n]*(?:[{},-][^\S\r\n]*)?["']?(?:mcp_servers|mcpServers)["']?[^\S\r\n]*(?:[=:]|\.[^\r\n]*[=:])/im.test(text) ||
    /^[^\S\r\n]*(?:[{},-][^\S\r\n]*)?["']?(?:command|args|env|http_headers|env_http_headers|bearer_token_env_var|headers)["']?[^\S\r\n]*(?:[=:]|\.[^\r\n]*[=:])/im.test(text)
}

function exactVersion(value, registry) {
  if (!nonempty(value) || !/\d/.test(value) || /[\s*^~<>=|,\[\](){}\/]/.test(value) || /(?:^|[.\-_])x(?:$|[.\-_])/i.test(value)) return false
  if (registry === 'npm') return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
  return /^\d[0-9A-Za-z.!+_-]*$/.test(value)
}

function fromName(value) {
  const name = value.trim()
  const qualified = /^(npm|pypi|crates\.io|packagist|maven|go|nuget):(.+)$/.exec(name)
  if (qualified) {
    const at = qualified[2].lastIndexOf('@')
    return { name, server: null, registry: qualified[1], package: at > 0 ? qualified[2].slice(0, at) : qualified[2], version: at > 0 ? qualified[2].slice(at + 1) : null }
  }
  const at = name.lastIndexOf('@')
  // An ordinary registry server such as org.example/server@1.0.0 is not an npm package.
  if (at > 0 && npmName(name.slice(0, at)) && nonempty(name.slice(at + 1))) {
    return { name, server: null, package: name.slice(0, at), registry: 'npm', version: name.slice(at + 1) }
  }
  return { name, server: null, package: null, registry: null, version: null }
}

function normalizeInput(value, position, locale) {
  const msg = (zh, en) => locale === 'en' ? en : zh
  const rejectControls = (item) => {
    if (typeof item === 'string' && FIELD_CONTROLS.test(item)) throw new Error(msg('清单字段不能包含控制字符。', 'Inventory fields must not contain control characters.'))
  }
  rejectControls(value)
  if (typeof value === 'string' && nonempty(value)) return fromName(value)
  if (!object(value) || Object.keys(value).some((key) => !INPUT_FIELDS.includes(key))) {
    throw new Error(msg('第 ' + position + ' 项格式不支持：只接受名称或 name/server/package/registry/version 字段，不接受启动配置、环境变量或凭据。', 'Item ' + position + ' is not supported. Use a name or the name/server/package/registry/version fields; do not provide launch configuration, environment variables, or credentials.'))
  }
  const result = {}
  for (const field of INPUT_FIELDS) {
    const item = value[field]
    if (item !== undefined && item !== null && typeof item !== 'string') throw new Error(msg('第 ' + position + ' 项的 ' + field + ' 必须是文本或 null。', 'The ' + field + ' field in item ' + position + ' must be text or null.'))
    rejectControls(item)
    result[field] = typeof item === 'string' && item.trim() ? item.trim() : null
  }
  result.name = result.name || result.server || result.package
  if (!result.name) throw new Error(msg('第 ' + position + ' 项缺少名称，请提供 name、server 或 package。', 'Item ' + position + ' has no name. Provide name, server, or package.'))
  return result
}

export function parseInventory(text, options = {}) {
  const locale = options?.locale === 'en' ? 'en' : 'zh'
  const msg = (zh, en) => locale === 'en' ? en : zh
  const format = options?.format === undefined ? 'auto' : options.format
  if (!['auto', 'json', 'text'].includes(format)) throw new Error(msg('清单格式必须为 auto、json 或 text。', 'The inventory format must be auto, json, or text.'))
  if (typeof text !== 'string') throw new Error(msg('请提供文本清单或 JSON 文本。', 'Provide a plain-text inventory or JSON text.'))
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error(msg('清单不能超过 1 MB。', 'The inventory cannot exceed 1 MB.'))
  if (DOCUMENT_CONTROLS.test(text)) throw new Error(msg('清单包含不允许的控制字符，请检查文件编码并只提供工具名称和版本。', 'The inventory contains unsupported control characters. Check the file encoding and provide tool names and versions only.'))
  const trimmed = text.trim()
  if (!trimmed && format !== 'json') return []
  let values
  const startsJSON = /^[\[{]/.test(trimmed)
  if (format === 'text' && startsJSON) throw new Error(msg('文本模式不接受 JSON 或配置结构，请改用 JSON 模式或每行一个工具名称。', 'Text mode does not accept JSON or configuration structures. Use JSON mode or one tool name per line.'))
  if (format === 'json' || startsJSON) {
    let parsed
    try { parsed = JSON.parse(trimmed) } catch { throw new Error(msg('JSON 格式错误，请使用数组或 {"tools":[...]}。', 'Invalid JSON. Use an array or {"tools":[...]}.')) }
    if (Array.isArray(parsed)) values = parsed
    else if (object(parsed) && Object.keys(parsed).length === 1 && own(parsed, 'tools') && Array.isArray(parsed.tools)) values = parsed.tools
    else throw new Error(msg('JSON 只接受数组或 {"tools":[...]}；不能导入 mcpServers、env 或其它配置结构。', 'JSON must be an array or {"tools":[...]}. mcpServers, env, and other configuration structures are not accepted.'))
  } else {
    if (looksLikeLaunchConfig(trimmed)) throw new Error(msg('不能导入启动配置、环境变量或请求头，请只提供工具名称和版本；本地配置请先使用 discover。', 'Do not import launch configuration, environment variables, or headers. Provide tool names and versions only; use discover for local configuration first.'))
    values = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  }
  if (values.length > MAX_ENTRIES) throw new Error(msg('一次最多支持 500 项工具。', 'A single inventory can contain at most 500 tools.'))
  return values.map((value, index) => ({ id: 'tool-' + (index + 1), ...normalizeInput(value, index + 1, locale) }))
}

function inputProjection(entry) {
  return Object.fromEntries(INPUT_FIELDS.map((field) => [field, textOrNull(entry?.[field])]))
}

function findingProjection(finding, block) {
  const result = { block }
  for (const field of ['rule', 'severity', 'file', 'message', 'evidence']) result[field] = textOrNull(finding?.[field])
  return result
}

function provenanceProjection(value) {
  if (!object(value)) return null
  return {
    package: { registry: textOrNull(value.package?.registry), name: textOrNull(value.package?.name), version: textOrNull(value.package?.version) },
    content: { algorithm: textOrNull(value.content?.algorithm), digest: textOrNull(value.content?.digest), scope: textOrNull(value.content?.scope) },
    complete: value.complete === true,
  }
}

function evidenceOf(record) {
  if (!object(record?.evidence)) return []
  return Object.keys(record.evidence).map((block) => {
    const value = record.evidence[block]
    return {
      block, status: textOrNull(value?.status), source: textOrNull(value?.source), reason: textOrNull(value?.reason),
      observedAt: textOrNull(value?.observedAt), auditedAt: textOrNull(value?.auditedAt), scanner: textOrNull(value?.scanner),
      provenance: provenanceProjection(value?.provenance),
      findings: Array.isArray(value?.findings) ? value.findings.map((finding) => findingProjection(finding, block)) : [],
    }
  })
}

function executionProjection(wrapper) {
  if (!object(wrapper) || !object(wrapper.scanner_execution)) return null
  const exec = wrapper.scanner_execution
  const components = (Array.isArray(exec.components) ? exec.components : []).map((component) => ({
    id: textOrNull(component?.id),
    required: component?.required === true,
    status: textOrNull(component?.status),
    output_present: component?.output_present === true,
    output_parseable: component?.output_parseable === true,
    semantic_consistency: textOrNull(component?.semantic_consistency),
    reason: textOrNull(component?.reason),
    findings: Object.fromEntries(SEVERITIES.map((severity) => [severity, Number.isInteger(component?.findings?.[severity]) ? component.findings[severity] : 0])),
  }))
  const count = (value) => Number.isInteger(value) && value >= 0 ? value : null
  return {
    state: textOrNull(exec.state),
    required: count(exec.required),
    completed: count(exec.completed),
    failed: count(exec.failed),
    generatedAt: textOrNull(wrapper.generatedAt),
    components,
  }
}

/**
 * The coverage block is its own claim about which scanners ran. Evidence that looks complete while
 * its own coverage block says a required scanner did not finish is a contradiction, and a
 * contradiction cannot be matched. Records written before the block existed carry no
 * `scanExecution` and are unaffected; they are handled by the block-level checks above.
 */
function coverageProblem(record, locale) {
  const msg = (zh, en) => locale === 'en' ? en : zh
  const wrapper = record?.scanExecution
  if (!object(wrapper)) return null
  const exec = wrapper.scanner_execution
  if (!object(exec) || !Array.isArray(exec.components)) return msg('这条记录带有扫描覆盖块，但格式不完整，不能作为完整证据。', 'This record has a scan-coverage block, but its format is incomplete and cannot be treated as complete evidence.')
  const required = exec.components.filter((component) => object(component) && component.required === true)
  const finished = required.filter((component) => component.status === 'completed' && component.output_present === true && component.output_parseable === true && component.semantic_consistency === 'ok')
  if ([exec.required, exec.completed, exec.failed].some((value) => Number.isInteger(value) && value >= 0) &&
      (exec.required !== required.length || exec.completed !== finished.length || exec.failed !== required.length - finished.length)) {
    return msg('这条记录的扫描覆盖块计数与列出的扫描器不一致，不能作为完整证据。', 'The scan-coverage counts do not match the listed scanners, so the record cannot be treated as complete evidence.')
  }
  if (exec.state !== 'complete' || required.length === 0 || finished.length !== required.length) return msg('这条记录的扫描覆盖块显示并非所有必需的扫描器都跑完，不能作为完整证据。', 'The scan-coverage block shows that not every required scanner completed, so the record cannot be treated as complete evidence.')
  if (object(wrapper.digest) && wrapper.digest.matches === false) return msg('这条记录的内容摘要与扫描覆盖块记录不一致，不能作为完整证据。', 'The content digest does not match the scan-coverage record, so it cannot be treated as complete evidence.')
  return null
}

function bindingProblem(record, candidate, locale) {
  const msg = (zh, en) => locale === 'en' ? en : zh
  if (!object(record) || !nonempty(record.server) || !Array.isArray(record.packages) ||
      record.packages.some((pkg) => !object(pkg) || !nonempty(pkg.registry) || !nonempty(pkg.name) || !exactVersion(pkg.version, pkg.registry))) return msg('索引记录缺少可核对的精确包身份，或包记录格式不完整。', 'The index record lacks a verifiable exact package identity, or the package record is incomplete.')
  if (!nonempty(candidate.package) || !nonempty(candidate.registry) || !exactVersion(candidate.version, candidate.registry)) return msg('该记录没有可核对的精确包身份和版本。', 'This record has no verifiable exact package identity and version.')
  if (candidate.registry === 'npm' && !npmName(candidate.package)) return msg('索引中的 npm 包名格式不完整，不能核对包身份。', 'The npm package name in the index is malformed and cannot be used to verify package identity.')
  if (record.verdict === 'incomplete' || (record.verdict !== undefined && !['clean', 'findings', 'incomplete'].includes(record.verdict))) return msg('索引将这条记录标为未完成或未知状态。', 'The index marks this record as incomplete or unknown.')
  const coverage = coverageProblem(record, locale)
  if (coverage) return coverage
  if (!object(record.evidence) || Object.keys(record.evidence).length === 0) return msg('索引没有提供检查证据。', 'The index provides no inspection evidence.')
  for (const [block, evidence] of Object.entries(record.evidence)) {
    if (!object(evidence) || !['clean', 'findings'].includes(evidence.status) || !nonempty(evidence.source) || !Array.isArray(evidence.findings)) return block + msg(' 未完成检查，或证据格式不完整。', ' did not complete inspection, or its evidence format is incomplete.')
    if (nonempty(evidence.reason) || nonempty(evidence.error)) return block + msg(' 仍带有检查未完成或失败的说明，需要先核对。', ' still contains an incomplete or failed-check reason and must be reviewed.')
    if ((evidence.status === 'clean' && evidence.findings.length > 0) || (evidence.status === 'findings' && evidence.findings.length === 0)) return block + msg(' 的检查状态与发现列表相互矛盾。', ' has a status that contradicts its findings list.')
    if (evidence.findings.some((finding) => !object(finding) || !nonempty(finding.rule) || !SEVERITIES.includes(finding.severity) || (!nonempty(finding.evidence) && !nonempty(finding.message)))) return block + msg(' 包含未知或缺少说明的发现，不能作为完整证据。', ' contains an unknown or unexplained finding and cannot be treated as complete evidence.')
    const proof = evidence.provenance
    if (!object(proof) || proof.complete !== true || !object(proof.package) || !object(proof.content)) return block + msg(' 缺少完整的内容来源证明。', ' lacks complete content provenance.')
    if (proof.package.registry !== candidate.registry || proof.package.name !== candidate.package || proof.package.version !== candidate.version) return block + msg(' 的来源证明与所选包、来源或版本不一致。', ' provenance does not match the selected package, registry, or version.')
    if (proof.content.algorithm !== 'sha256' || typeof proof.content.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(proof.content.digest) || !nonempty(proof.content.scope)) return block + msg(' 缺少有效 SHA256 内容摘要或明确的检查范围。', ' lacks a valid SHA-256 content digest or an explicit inspection scope.')
  }
  return null
}

function candidateGroups(records) {
  const groups = new Map()
  for (const record of records) {
    if (!object(record) || !nonempty(record.server)) continue
    const packages = Array.isArray(record.packages) && record.packages.length > 0 ? record.packages : [null]
    for (const pkg of packages) {
      const candidate = { server: record.server, package: textOrNull(pkg?.name), registry: textOrNull(pkg?.registry), version: textOrNull(pkg?.version) }
      const key = 'candidate:' + JSON.stringify([candidate.server, candidate.registry, candidate.package, candidate.version])
      const existing = groups.get(key)
      if (existing) existing.records.push(record)
      else groups.set(key, { key, ...candidate, records: [record] })
    }
  }
  return [...groups.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

function candidatesFor(entry, groups) {
  const pool = groups.filter((candidate) => !entry.registry || candidate.registry === entry.registry)
  let exact
  if (entry.server || entry.package) {
    exact = pool.filter((candidate) => (!entry.server || candidate.server === entry.server) && (!entry.package || candidate.package === entry.package))
  } else {
    exact = pool.filter((candidate) => candidate.server === entry.name)
    if (exact.length === 0) exact = pool.filter((candidate) => candidate.package === entry.name)
  }
  if (exact.length > 0) return { candidates: exact, exact: true }
  const includes = (haystack, needle) => typeof haystack === 'string' && haystack.toLowerCase().includes(needle.toLowerCase())
  const fuzzy = pool.filter((candidate) => {
    if (entry.server || entry.package) return (!entry.server || includes(candidate.server, entry.server)) && (!entry.package || includes(candidate.package, entry.package))
    return includes(candidate.server, entry.name) || includes(candidate.package, entry.name) || candidate.records.some((record) => includes(record.title, entry.name))
  })
  return { candidates: fuzzy, exact: false }
}

const candidateProjection = (candidate) => ({ key: candidate.key, server: candidate.server, package: candidate.package, registry: candidate.registry, version: candidate.version })
const selectedProjection = (candidate) => ({ server: candidate.server, package: candidate.package, registry: candidate.registry, version: candidate.version })

function setState(item, state, reason, steps, locale) {
  const labels = locale === 'en' ? LABELS_EN : LABELS_ZH
  const limit = locale === 'en' ? LIMIT_EN : LIMIT_ZH
  return { ...item, state, label: labels[state], reason, nextSteps: [...(steps || []), limit] }
}

export function createInventoryReport(entries, index, options = {}) {
  const locale = options?.locale === 'en' ? 'en' : 'zh'
  const msg = (zh, en) => locale === 'en' ? en : zh
  if (!Array.isArray(entries)) throw new Error(msg('工具清单必须是数组，请先解析清单。', 'The tool inventory must be an array. Parse it before generating a report.'))
  if (entries.length > MAX_ENTRIES) throw new Error(msg('一次最多支持 500 项工具。', 'A single inventory can contain at most 500 tools.'))
  const validIndex = object(index) && Array.isArray(index.records)
  const records = validIndex ? index.records : []
  const groups = candidateGroups(records)
  const snapshot = index?.snapshot === true || index?.sample === true
  const truncated = index?.truncated === true
  const selections = object(options?.selections) ? options.selections : {}
  const counts = new Map()
  const ids = new Map()
  for (const entry of entries) {
    const input = inputProjection(entry)
    const key = JSON.stringify([input.server, input.package, input.registry, input.version, input.server || input.package ? null : input.name])
    counts.set(key, (counts.get(key) || 0) + 1)
    ids.set(entry?.id, (ids.get(entry?.id) || 0) + 1)
  }
  const items = entries.map((entry, position) => {
    const input = inputProjection(entry)
    const id = typeof entry?.id === 'string' ? entry.id : 'tool-' + (position + 1)
    let item = { id, input, state: 'insufficient', label: (locale === 'en' ? LABELS_EN : LABELS_ZH).insufficient, reason: '', nextSteps: [], candidates: [], selected: null, evidenceGeneratedAt: null, evidence: [], execution: null, findings: [] }
    const wellFormed = object(entry) && /^tool-[1-9]\d*$/.test(id) && nonempty(entry.name) &&
      Object.keys(entry).every((key) => INPUT_FIELDS.includes(key) || key === 'id') &&
      INPUT_FIELDS.every((key) => entry[key] === null || entry[key] === undefined || typeof entry[key] === 'string')
    if (!wellFormed) return setState(item, 'insufficient', msg('这项工具记录格式不完整，不能据此匹配。', 'This tool record is incomplete and cannot be matched.'), [msg('只保留名称、包名、来源和你实际使用的版本，再重新导入。', 'Keep only the name, package, registry, and the version you actually use, then import it again.')], locale)
    const duplicateKey = JSON.stringify([input.server, input.package, input.registry, input.version, input.server || input.package ? null : input.name])
    if (counts.get(duplicateKey) > 1 || ids.get(entry.id) > 1) return setState(item, 'insufficient', msg('清单中存在重复工具或重复标识，需要先核对并去重。', 'The inventory contains duplicate tools or identifiers and must be deduplicated.'), [msg('保留一条真实工具记录，或补充不同的包、来源和版本。', 'Keep one real tool record, or add the distinct package, registry, and version.')], locale)
    if (!validIndex) return setState(item, 'insufficient', msg('当前索引格式错误或没有可读取的记录列表。', 'The current index is invalid or has no readable record list.'), [msg('提供有效的证据索引后重新生成报告。', 'Provide a valid evidence index and generate the report again.')], locale)
    const matches = candidatesFor(input, groups)
    item.candidates = matches.candidates.map(candidateProjection)
    if (matches.candidates.length === 0) return setState(item, 'unmatched', msg('当前索引中没有找到对应工具；这不表示工具安全或不存在。', 'No matching tool was found in the current index. This does not mean the tool is safe or nonexistent.') + (truncated ? msg('本次索引已截断，未覆盖全部记录。', ' This index was truncated and does not contain every record.') : ''), [msg('核对准确的 registry server、包名及来源，必要时使用完整索引。', 'Confirm the exact registry server, package name, and source. Use the complete index if needed.')], locale)
    const selection = own(selections, id) ? selections[id] : null
    let candidate = selection ? matches.candidates.find((candidate) => candidate.key === selection) : null
    if (selection && !candidate) return setState(item, 'ambiguous', msg('之前选择的候选已不在当前结果中，请重新确认。', 'The previously selected candidate is no longer in the current result. Confirm it again.'), [msg('从当前候选中选择你实际使用的工具。', 'Choose the tool you actually use from the current candidates.')], locale)
    if (!candidate) {
      const sameVersion = matches.candidates.filter((candidate) => exactVersion(input.version, candidate.registry) && input.version === candidate.version)
      const choices = sameVersion.length > 0 ? sameVersion : matches.candidates
      if (!matches.exact || choices.length !== 1) return setState(item, 'ambiguous', matches.exact ? msg('存在多个包、来源或版本候选，不能自动确定你的工具。', 'Multiple package, registry, or version candidates exist. The page cannot choose your tool automatically.') : msg('这些只是名称相近的候选，即使只有一项也需要你确认。', 'These candidates have similar names only. You must confirm the match even when one candidate remains.'), [msg('选择实际使用的候选，并填写你自己的精确版本。', 'Select the candidate you actually use and enter your own exact version.')], locale)
      candidate = choices[0]
    }
    item.selected = selectedProjection(candidate)
    item.evidenceGeneratedAt = textOrNull(candidate.records[0].generatedAt ?? index.generatedAt)
    item.evidence = evidenceOf(candidate.records[0])
    item.execution = executionProjection(candidate.records[0].scanExecution)
    item.findings = item.evidence.flatMap((evidence) => evidence.findings)
    if (candidate.records.length !== 1) return setState(item, 'insufficient', msg('索引中有相同包身份的重复记录，无法确认哪一份证据有效。', 'The index contains duplicate records for the same package identity, so the valid evidence cannot be determined.'), [msg('先核对重复索引记录，再生成报告。', 'Review the duplicate index records before generating the report.')], locale)
    if (!nonempty(candidate.package) || !nonempty(candidate.registry) || !exactVersion(candidate.version, candidate.registry)) return setState(item, 'insufficient', msg('索引记录缺少精确包身份或版本，不能核对你所用的版本。', 'The index record lacks an exact package identity or version and cannot be matched to your version.'), [msg('获取带有准确包名、来源和精确版本的索引记录。', 'Obtain an index record with the exact package name, registry, and version.')], locale)
    if (!exactVersion(input.version, candidate.registry)) return setState(item, 'version_missing', msg('需要你实际使用的精确版本；空值、latest 或版本范围都不能用于证据匹配。', 'Your exact installed version is required. Empty values, latest, and version ranges cannot be matched to evidence.'), [msg('填写本机或配置中确认的实际版本；不要直接复制候选版本。', 'Enter the version confirmed from your own machine or configuration; do not copy the candidate version without verification.')], locale)
    if (input.version !== candidate.version) return setState(item, 'version_mismatch', msg('你提供的版本 ' + input.version + ' 与索引候选版本 ' + (candidate.version || '未记录') + ' 不同，现有证据不能移用。', 'Your version ' + input.version + ' differs from the index candidate ' + (candidate.version || 'not recorded') + '. Existing evidence cannot be transferred to another version.'), [msg('获取你所用版本的对应证据，或核对版本填写是否准确。', 'Obtain evidence for the version you use, or confirm that the version was entered correctly.')], locale)
    if (snapshot) return setState(item, 'insufficient', msg('当前索引是历史样本快照，不能作为你的工具已完成检查的证明。', 'The current index is a historical sample and cannot prove that your tool completed inspection.'), [msg('换用带有当前检查来源证明的真实索引。', 'Use a current index with provenance for the inspected material.')], locale)
    if (['snapshot', 'sample'].some((key) => own(index, key) && typeof index[key] !== 'boolean')) return setState(item, 'insufficient', msg('索引的快照或样本标记格式不明确，无法确认其证据用途。', 'The index snapshot/sample marker is malformed, so its evidentiary use cannot be determined.'), [msg('核对索引来源、快照和样本标记。', 'Review the index source and its snapshot and sample markers.')], locale)
    if (!nonempty(item.evidenceGeneratedAt) || !Number.isFinite(Date.parse(item.evidenceGeneratedAt))) return setState(item, 'insufficient', msg('索引和记录没有提供可解析的证据生成时间，无法说明这些材料何时被检查。', 'The index and record provide no parseable evidence-generation time, so the inspection time cannot be stated.'), [msg('补充真实的证据生成时间后重新核对；不要自行猜测时间。', 'Add the actual evidence-generation time and check again; do not guess it.')], locale)
    const problem = bindingProblem(candidate.records[0], candidate, locale)
    if (problem) return setState(item, 'insufficient', problem, [msg('补齐对应版本的完整检查状态、内容摘要和检查范围。', 'Provide complete inspection status, content digest, and scope for the corresponding version.')], locale)
    item = setState(item, 'matched', msg('工具身份、你的精确版本与列出的检查证据对应；这不是安全认证。', 'The tool identity and your exact version match the listed inspection evidence. This is not a security certification.'), item.findings.length ? [msg('逐条查看下面的发现，并决定是否需要人工处理。', 'Review each finding below and decide whether manual action is required.')] : [msg('如工具版本或材料发生变化，请重新核对证据。', 'Recheck the evidence when the tool version or inspected material changes.')], locale)
    if (item.findings.length > 0) item.label = msg('版本与证据对应，有发现待查看', 'Version and evidence matched; findings require review')
    return item
  })
  return {
    schemaVersion: 1,
    locale,
    generatedAt: nonempty(options?.generatedAt) ? options.generatedAt : new Date().toISOString(),
    index: {
      generatedAt: textOrNull(index?.generatedAt), snapshot, scanner: textOrNull(index?.scanner), truncated,
      total: Number.isInteger(index?.total) && index.total >= records.length ? index.total : records.length,
    },
    summary: { total: items.length, matched: items.filter((item) => item.state === 'matched').length, needsAttention: items.filter((item) => item.state !== 'matched' || item.findings.length > 0).length },
    items,
  }
}
