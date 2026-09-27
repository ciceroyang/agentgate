import test from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { scratchDir } from "./tmpdir.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const script = join(ROOT, "scripts/pack-release.mjs")
const run = args => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120000 })

test("the release gate accepts the actual tarball and refuses later byte changes or overwrites", () => {
  const output = join(scratchDir("ag-release-test-"), "candidate")
  const result = run(["--out-dir", output])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const receipt = JSON.parse(result.stdout)
  const acceptance = JSON.parse(readFileSync(join(output, "acceptance.json"), "utf8"))
  assert.equal(acceptance.summary.failed, 0)
  assert.ok(acceptance.checks.some(check => check.id === "codex-config" && check.passed))
  assert.ok(acceptance.checks.some(check => check.id === "valid-required-evidence" && check.passed))
  const verified = run(["--verified-path", receipt.receipt])
  assert.equal(verified.status, 0, verified.stderr)
  assert.equal(verified.stdout.trim(), receipt.tarballPath)
  const repeated = run(["--out-dir", output])
  assert.equal(repeated.status, 1, "must not overwrite an earlier result")
  appendFileSync(receipt.tarballPath, "changed after acceptance")
  const changed = run(["--verified-path", receipt.receipt])
  assert.equal(changed.status, 1)
  assert.match(changed.stderr, /安装包在验收后发生变化/)
})

test("CI checks delivered packages and publish names the verified tarball instead of repacking", () => {
  const publish = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf8")
  const ci = readFileSync(join(ROOT, ".github/workflows/test.yml"), "utf8")
  assert.match(publish, /node scripts\/pack-release\.mjs --out-dir/)
  assert.match(publish, /node scripts\/pack-release\.mjs --verified-path/)
  assert.match(publish, /npm publish "\$tarball" --ignore-scripts --provenance --access public --tag next/)
  assert.equal((ci.match(/run: npm run test:package/g) || []).length, 2, "test the delivery on both supported CI runtimes")
})
