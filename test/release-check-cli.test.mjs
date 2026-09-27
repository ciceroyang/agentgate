import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(ROOT, "scripts", "release-check.mjs")
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version

function run(args) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), { cwd: ROOT, encoding: "utf8" })
}

test("this repository passes its own release check offline", function () {
  const out = run(["--skip-tests"])
  assert.equal(out.status, 0, out.stdout + out.stderr)
  assert.match(out.stdout, /发布预检通过/)
  assert.match(out.stdout, /仍须安装包验收、CI 发布与公开回读/)
  assert.equal(out.stdout.indexOf("FAIL"), -1, out.stdout)
})

test("the tag has to agree with the version in package.json", function () {
  const ok = run(["--skip-tests", "--tag", "v" + version])
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const bad = run(["--skip-tests", "--tag", "v9.9.9"])
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /tag 与版本一致/)
})

test("a version that is not the one in the package is refused", function () {
  const out = run(["--skip-tests", "--version", "9.9.9"])
  assert.equal(out.status, 1)
  assert.match(out.stdout, /package.json 的版本与 --version 一致/)
})

test("--format json carries every check", function () {
  const out = run(["--skip-tests", "--format", "json"])
  const body = JSON.parse(out.stdout)
  assert.equal(body.ok, true)
  assert.equal(body.version, version)
  assert.ok(body.checks.length >= 10, "there should be a check for each claim")
  assert.ok(Array.isArray(body.warnings))
})
