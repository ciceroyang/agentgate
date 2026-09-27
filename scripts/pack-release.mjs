#!/usr/bin/env node
/** Pack once, accept the extracted bytes, and retain the exact tarball for publication.
 * Local only: no install, registry access, publish, tag, or project discovery.
 *   node scripts/pack-release.mjs [--out-dir NEW_DIRECTORY]
 *   node scripts/pack-release.mjs --verified-path RECEIPT_JSON
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { classifyPack, integrity, manifestProblems, packedReceiptProblems, sha256 } from "../packages/release/src/release.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const jsonAt = path => JSON.parse(readFileSync(path, "utf8"))
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(command + " failed (" + result.status + "):\n" + result.stdout + result.stderr)
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
    if (args.length) mkdirSync(output, { mode: 0o700 })
    const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output]))
    if (!Array.isArray(packed) || packed.length !== 1) throw new Error("Expected exactly one npm package")
    const entry = packed[0]
    if (entry.name !== pkg.name || entry.version !== pkg.version) throw new Error("Packed identity differs from package.json")
    const tarball = join(output, safeFilename(entry.filename))
    const bytes = readFileSync(tarball)
    if (integrity(bytes) !== entry.integrity) throw new Error("npm pack integrity differs from the actual tarball")
    const content = classifyPack(entry.files.map(file => file.path), { allow: pkg.files.concat("package.json") })
    reject(content.missing.map(path => "Missing packaged file: " + path).concat(content.leaks.map(item => "Forbidden packaged file: " + item.path)))
    // Only extract the tarball just produced by npm, and refuse unexpected path shapes first.
    const paths = run("tar", ["-tzf", tarball]).trim().split("\n")
    if (paths.some(path => !path.startsWith("package/") || path.includes("\\") || path.split("/").includes(".."))) {
      throw new Error("Unexpected path in npm tarball")
    }
    const extracted = join(output, "extracted")
    mkdirSync(extracted)
    run("tar", ["-xzf", tarball, "-C", extracted])
    const packageRoot = join(extracted, "package")
    const delivered = jsonAt(join(packageRoot, "package.json"))
    reject(manifestProblems(delivered, jsonAt(join(packageRoot, "server.json")), plugin))
    if (delivered.name !== pkg.name || delivered.version !== pkg.version) throw new Error("Extracted package identity differs")
    const reported = run(process.execPath, [join(packageRoot, "bin/agentgate.mjs"), "version"], output).trim()
    if (reported !== "agentgate " + pkg.version) throw new Error("Extracted CLI reports a different version: " + reported)
    const acceptancePath = join(output, "acceptance.json")
    run(process.execPath, [join(ROOT, "scripts/check-delivery.mjs"), packageRoot, "packed-release-candidate", acceptancePath], output)
    const acceptanceBytes = readFileSync(acceptancePath)
    const acceptance = JSON.parse(acceptanceBytes)
    const receipt = {
      schemaVersion: 1, kind: "verified-local-package", generatedAt: new Date().toISOString(),
      package: { name: pkg.name, version: pkg.version },
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      tarball: { filename: entry.filename, bytes: bytes.length, integrity: integrity(bytes), sha256: sha256(bytes) },
      acceptance: { filename: "acceptance.json", sha256: sha256(acceptanceBytes), summary: acceptance.summary },
      content: { files: entry.files.length, unexplained: content.unexplained },
      boundary: "Local synthetic acceptance only; not a public release, customer acceptance, or a signed attestation.",
    }
    reject(packedReceiptProblems(receipt, bytes, acceptanceBytes, pkg))
    const receiptPath = join(output, "release.json")
    save(receiptPath, receipt)
    process.stdout.write(JSON.stringify({ ...receipt, output, receipt: receiptPath, tarballPath: tarball }, null, 2) + "\n")
  }
} catch (error) {
  console.error("Package acceptance failed: " + error.message)
  process.exitCode = 1
}
