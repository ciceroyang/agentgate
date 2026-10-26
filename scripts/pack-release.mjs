#!/usr/bin/env node
/** Pack once, install that exact local tarball offline, and retain it for publication.
 * Local synthetic acceptance only: no registry access, install hooks, publish, tag,
 * or discovery of the user's real projects/configuration.
 *   node scripts/pack-release.mjs [--out-dir NEW_DIRECTORY]
 *   node scripts/pack-release.mjs --verified-path RECEIPT_JSON
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { classifyPack, integrity, manifestProblems, packedReceiptProblems, sha256 } from "../packages/release/src/release.mjs"
import { findNpmCli, npmInvocation } from "../packages/release/src/npm-cli.mjs"
import { withStagedTarball } from "../packages/release/src/staged-tarball.mjs"
import { createProgressJournal } from "../packages/release/src/progress.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const jsonAt = path => JSON.parse(readFileSync(path, "utf8"))
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
let progress = () => {}
function run(command, args, cwd = ROOT, env, stage = "command", spawnOptions = {}) {
  progress(stage, "started")
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...spawnOptions })
  if (result.error) {
    progress(stage, "failed")
    throw new Error(stage + " could not complete: " + result.error.code +
      " (timeout 120000ms, signal " + String(result.signal) + ")", { cause: result.error })
  }
  if (result.status !== 0) {
    progress(stage, "failed")
    throw new Error(stage + " failed (" + result.status + "):\n" + result.stdout + result.stderr)
  }
  progress(stage, "passed")
  return result.stdout
}
function reject(problems) { if (problems.length) throw new Error(problems.join("\n")) }
function safeFilename(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(name) || basename(name) !== name) {
    throw new Error("Invalid tarball filename")
  }
  return name
}

try {
  const args = process.argv.slice(2)
  if (args[0] === "--verified-path" && args.length === 2) {
    const path = resolve(args[1])
    const receipt = jsonAt(path)
    const tarball = join(dirname(path), safeFilename(receipt.tarball?.filename))
    const acceptanceBytes = readFileSync(join(dirname(path), "acceptance.json"))
    reject(packedReceiptProblems(receipt, readFileSync(tarball), acceptanceBytes, pkg))
    process.stdout.write(tarball + "\n")
  } else {
    if (args.length && (args.length !== 2 || args[0] !== "--out-dir" || !args[1])) {
      throw new Error("usage: pack-release.mjs [--out-dir NEW_DIRECTORY | --verified-path RECEIPT_JSON]")
    }
    const server = jsonAt(join(ROOT, "server.json"))
    const plugin = jsonAt(join(ROOT, "lhm.plugin.json"))
    reject(manifestProblems(pkg, server, plugin))
    // A supplied output directory must be new: never overwrite an earlier acceptance result.
    const output = args.length ? resolve(args[1]) : mkdtempSync(join(tmpdir(), "agentgate-release-"))
    // npm's generated cmd-shim expands its own directory in an unquoted SET.
    // Native acceptance proved '&' splits it before AgentGate starts. Do not patch
    // npm, bypass its launcher, or mislabel a direct Node run as a shim pass.
    if (process.platform === "win32" && /[&%]/.test(output)) {
      throw new Error("Windows npm command launcher requires an acceptance directory without & or %; choose a new writable directory (Unicode and spaces are supported). No installed-launcher success is claimed for this path.")
    }
    if (args.length) mkdirSync(output, { mode: 0o700 })
    progress = createProgressJournal(join(output, "progress.jsonl"), [
      "npm pack", "list packed archive", "extract packed archive", "npm install",
      "installed launcher version", "installed delivery checks", "release receipt",
    ])
    const home = join(output, "acceptance-home")
    const cache = join(output, "npm-cache")
    const temporary = join(output, "tmp")
    for (const directory of [home, cache, temporary]) mkdirSync(directory, { mode: 0o700 })
    const userconfig = join(home, "user.npmrc")
    const globalconfig = join(home, "global.npmrc")
    for (const config of [userconfig, globalconfig]) writeFileSync(config, "\n", { flag: "wx", mode: 0o600 })
    // Do not inherit credentials, proxy settings, NODE_OPTIONS or the real user's npm
    // configuration. An empty cache + --offline also makes undeclared registry needs fail.
    const env = {
      PATH: [dirname(process.execPath), process.env.PATH || ""].join(delimiter),
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
      npm_config_cache: cache, npm_config_offline: "true", npm_config_ignore_scripts: "true",
      npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
      NO_COLOR: "1",
    }
    // Windows subprocesses still need OS locations; never copy the whole environment.
    for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "SystemDrive"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    const npm = findNpmCli({ path: env.PATH })
    const runNpm = (args, cwd) => {
      const invocation = npmInvocation(npm, args)
      return run(invocation.command, invocation.args, cwd, env, "npm " + args[0])
    }
    const packed = JSON.parse(runNpm(["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", output], ROOT))
    if (!Array.isArray(packed) || packed.length !== 1) throw new Error("Expected exactly one npm package")
    const entry = packed[0]
    if (entry.name !== pkg.name || entry.version !== pkg.version) throw new Error("Packed identity differs from package.json")
    const tarball = join(output, safeFilename(entry.filename))
    const bytes = readFileSync(tarball)
    if (integrity(bytes) !== entry.integrity) throw new Error("npm pack integrity differs from the actual tarball")
    const content = classifyPack(entry.files.map(file => file.path), { allow: pkg.files.concat("package.json") })
    reject(content.missing.map(path => "Missing packaged file: " + path).concat(content.leaks.map(item => "Forbidden packaged file: " + item.path)))
    // Only extract the tarball just produced by npm, and refuse unexpected path shapes first.
    // GNU tar on Windows interprets an absolute drive-letter archive as host:path.
    // A validated basename and cwd work on GNU and BSD tar without shell quoting.
    const paths = run("tar", ["-tzf", safeFilename(entry.filename)], output, env, "list packed archive").trim().split(/\r?\n/)
    if (paths.some(path => !path.startsWith("package/") || path.includes("\\") || path.split("/").includes(".."))) {
      throw new Error("Unexpected path in npm tarball")
    }
    const extracted = join(output, "extracted")
    mkdirSync(extracted)
    run("tar", ["-xzf", safeFilename(entry.filename), "-C", "extracted"], output, env, "extract packed archive")
    const installed = join(output, "installed")
    mkdirSync(installed, { mode: 0o700 })
    save(join(installed, "package.json"), { name: "agentgate-offline-acceptance", version: "0.0.0", private: true })
    // npm 10 reparses local specs and can throw URI malformed for a literal '%'.
    // Stage the already-verified bytes outside the candidate directory; keep the
    // real install/acceptance path unchanged, including its special characters.
    withStagedTarball(bytes, staged => runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--no-save", staged], installed))
    const packageRoot = join(installed, "node_modules", ...pkg.name.split("/"))
    const delivered = jsonAt(join(packageRoot, "package.json"))
    reject(manifestProblems(delivered, jsonAt(join(packageRoot, "server.json")), plugin))
    if (delivered.name !== pkg.name || delivered.version !== pkg.version) throw new Error("Installed package identity differs")
    const executable = join(installed, "node_modules", ".bin", process.platform === "win32" ? "agentgate.cmd" : "agentgate")
    let reported
    if (process.platform === "win32") {
      if (!statSync(executable).isFile() || !readFileSync(executable, "utf8").includes('"%dp0%\\..\\@zhiliangtech\\agentgate\\bin\\agentgate.mjs"')) {
        throw new Error("Installed Windows launcher does not target the accepted package")
      }
      if (!env.SystemRoot) throw new Error("Windows SystemRoot is required to check the installed command launcher")
      // Execute npm's real .cmd shim. Keep the command itself fixed and relative:
      // no candidate path (possibly containing spaces, Unicode, &, %) enters cmd syntax.
      reported = run(join(env.SystemRoot, "System32", "cmd.exe"),
        ["/d", "/s", "/v:off", "/c", '"".\\node_modules\\.bin\\agentgate.cmd" version"'],
        installed, env, "installed launcher version", { windowsVerbatimArguments: true }).trim()
    } else {
      if (realpathSync(executable) !== realpathSync(join(packageRoot, "bin/agentgate.mjs"))) throw new Error("Installed executable does not point to the accepted package")
      reported = run(executable, ["version"], installed, env, "installed launcher version").trim()
    }
    if (reported !== "agentgate " + pkg.version) throw new Error("Installed CLI reports a different version: " + reported)
    const acceptancePath = join(output, "acceptance.json")
    run(process.execPath, [join(ROOT, "scripts/check-delivery.mjs"), packageRoot, "installed-release-candidate", acceptancePath], installed, env, "installed delivery checks")
    const acceptanceBytes = readFileSync(acceptancePath)
    const acceptance = JSON.parse(acceptanceBytes)
    const receipt = {
      schemaVersion: 1, kind: "verified-local-package", generatedAt: new Date().toISOString(),
      package: { name: pkg.name, version: pkg.version },
      runtime: { node: process.version, platform: process.platform, arch: process.arch, npm },
      tarball: { filename: entry.filename, bytes: bytes.length, integrity: integrity(bytes), sha256: sha256(bytes) },
      acceptance: { filename: "acceptance.json", sha256: sha256(acceptanceBytes), summary: acceptance.summary },
      content: { files: entry.files.length, unexplained: content.unexplained },
      installation: { method: "npm-offline-ignore-scripts", tarballStaging: "byte-verified-temporary-copy", packageRoot, executable, reportedVersion: reported },
      boundary: "Local synthetic acceptance only; not a public release, customer acceptance, or a signed attestation.",
    }
    reject(packedReceiptProblems(receipt, bytes, acceptanceBytes, pkg))
    const receiptPath = join(output, "release.json")
    progress("release receipt", "started")
    save(receiptPath, receipt)
    progress("release receipt", "passed")
    process.stdout.write(JSON.stringify({ ...receipt, output, receipt: receiptPath, tarballPath: tarball }, null, 2) + "\n")
  }
} catch (error) {
  console.error("Package acceptance failed: " + error.message)
  process.exitCode = 1
}
