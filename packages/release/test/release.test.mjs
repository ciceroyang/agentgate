import test from "node:test"
import assert from "node:assert/strict"
import { classifyPack, changelogHasVersion, manifestProblems, packedReceiptProblems, integrity, sha256, pathsFromPackJson, summarize, tagMatches, versionFromTag, REQUIRED_FILES } from "../src/release.mjs"

test("a tag is the version with an optional v", function () {
  assert.equal(versionFromTag("v0.1.1"), "0.1.1")
  assert.equal(versionFromTag("0.1.1"), "0.1.1")
  assert.equal(tagMatches("v0.1.1", "0.1.1"), true)
  assert.equal(tagMatches("v0.1.10", "0.1.1"), false)
  assert.equal(tagMatches("v0.2.0", "0.1.1"), false)
})

test("npm pack output is read, and anything else is refused", function () {
  const paths = pathsFromPackJson(JSON.stringify([{ files: [{ path: "LICENSE" }, { path: "bin/agentgate.mjs" }] }]))
  assert.deepEqual(paths, ["LICENSE", "bin/agentgate.mjs"])
  assert.deepEqual(pathsFromPackJson(JSON.stringify({ files: [{ path: "a" }] })), ["a"])
  assert.throws(function () { pathsFromPackJson("not json") }, /不是 JSON/)
  assert.throws(function () { pathsFromPackJson(JSON.stringify({})) }, /没有 files 列表/)
})

test("the changelog has to have this version's section, and 0.1.1 is not 0.1.10", function () {
  assert.equal(changelogHasVersion("## [0.1.1] - 2026-09-17\n", "0.1.1"), true)
  assert.equal(changelogHasVersion("## 0.1.1\n", "0.1.1"), true)
  assert.equal(changelogHasVersion("## [0.2.0]\n", "0.1.1"), false)
  assert.equal(changelogHasVersion("## [0.1.10] - x\n", "0.1.1"), false)
})

test("a tarball with a missing file, a leak or an unexplained path is classified", function () {
  const paths = REQUIRED_FILES.concat(["packages/x.mjs", "data/index.json", "docs/notes.md"])
  const classified = classifyPack(paths.filter(function (p) { return p !== "LICENSE" }), { allow: ["bin/", "packages/", "docs/spec/"] })
  assert.deepEqual(classified.missing, ["LICENSE"])
  assert.equal(REQUIRED_FILES.indexOf("bin/agentgate.mjs") !== -1, true)
  assert.deepEqual(classified.leaks.map(function (leak) { return leak.path }), ["data/index.json"])
  assert.deepEqual(classified.unexplained, ["package.json", "README.md", "server.json", "CHANGELOG.md", "docs/operations/upgrade.md", "docs/notes.md"])
})

test("a .env, a ledger and a tarball inside the package are all leaks", function () {
  const leaks = classifyPack([".env", "smtp.env", "data/history/ledger.jsonl", "dist/x.tgz", "a/b.log", "node_modules/x.js"], { allow: [] })
  assert.equal(leaks.leaks.length, 6)
})

test("a warning does not block a release and a problem does", function () {
  const warned = summarize([{ level: "warning", ok: false, detail: "dirty tree" }, { level: "problem", ok: true, detail: "fine" }])
  assert.equal(warned.ok, true)
  assert.deepEqual(warned.warnings, ["dirty tree"])
  const failed = summarize([{ level: "problem", ok: false, detail: "no changelog" }])
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.problems, ["no changelog"])
})

const pkg = { name: "@fixture/tool", version: "0.6.0", mcpName: "io.fixture/tool" }
const server = { name: pkg.mcpName, version: pkg.version, packages: [{ registryType: "npm", identifier: pkg.name, version: pkg.version }] }

test("all publishing manifests must agree, including the nested npm version", () => {
  assert.deepEqual(manifestProblems(pkg, server, { version: pkg.version }), [])
  for (const changed of [
    { ...server, version: "0.5.0" },
    { ...server, name: "io.other/tool" },
    { ...server, packages: [{ ...server.packages[0], version: "0.5.0" }] },
    { ...server, packages: [{ ...server.packages[0], identifier: "@other/tool" }] },
    { ...server, packages: [] },
    { ...server, packages: {} },
    { ...server, packages: [null] },
  ]) assert.ok(manifestProblems(pkg, changed, { version: pkg.version }).length > 0)
  assert.ok(manifestProblems(pkg, server, { version: "0.3.0" }).length > 0)
})

function accepted(checks = [{ id: "fixture", passed: true }]) {
  const tarball = Buffer.from("synthetic package bytes")
  const report = Buffer.from(JSON.stringify({ kind: "internal-delivery-acceptance", package: pkg, checks,
    summary: { checks: checks.length, passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length } }))
  const receipt = { schemaVersion: 1, kind: "verified-local-package", package: pkg,
    tarball: { integrity: integrity(tarball), sha256: sha256(tarball) }, acceptance: { sha256: sha256(report) } }
  return { tarball, report, receipt }
}

test("the publish receipt binds both the accepted archive and the report bytes", () => {
  const { tarball, report, receipt } = accepted()
  assert.deepEqual(packedReceiptProblems(receipt, tarball, report, pkg), [])
  assert.ok(packedReceiptProblems(receipt, Buffer.from("changed"), report, pkg).length > 0)
  assert.ok(packedReceiptProblems(receipt, tarball, Buffer.from("{}"), pkg).length > 0)
  assert.ok(packedReceiptProblems(receipt, tarball, report, { ...pkg, version: "0.7.0" }).length > 0)
  assert.ok(packedReceiptProblems({ ...receipt, kind: "unknown" }, tarball, report, pkg).length > 0)
})

test("an empty or failing acceptance cannot produce a publishable receipt", () => {
  for (const checks of [[], [{ id: "fixture", passed: false }], [{ id: "fixture", passed: "true" }]]) {
    const { tarball, report, receipt } = accepted(checks)
    assert.ok(packedReceiptProblems(receipt, tarball, report, pkg).length > 0)
  }
  const { tarball, receipt } = accepted()
  const report = Buffer.from("not json")
  receipt.acceptance.sha256 = sha256(report)
  assert.ok(packedReceiptProblems(receipt, tarball, report, pkg).some(p => p.includes("JSON")))
  for (const text of ["null", "false", "123"]) {
    const invalid = Buffer.from(text)
    receipt.acceptance.sha256 = sha256(invalid)
    assert.ok(packedReceiptProblems(receipt, tarball, invalid, pkg).some(p => p.includes("不是对象")))
  }
})
