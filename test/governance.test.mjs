import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { POLICY_VERSION } from "../packages/policy/src/policy.mjs"
import { SCHEMA_VERSION as SCAN_EXECUTION_VERSION } from "../packages/collect/src/execution.mjs"
import { PACK_SCHEMA } from "../packages/pack/src/pack.mjs"

/**
 * The two promises that are easy to make and easy to forget: what a version identifier means,
 * and what happens to somebody who already installed the previous one. Both are documentation, so
 * both go stale silently unless a test holds them to the code and to each other.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => readFileSync(join(ROOT, p), "utf8")

test("every spec states its stability and is listed in the compatibility policy", function () {
  const policy = read("docs/spec/compatibility.md")
  const specs = readdirSync(join(ROOT, "docs", "spec")).filter(function (name) { return /-v1\.md$/.test(name) })
  assert.ok(specs.length >= 5, "expected the five v1 specs, found " + specs.join(", "))
  for (const name of specs) {
    const text = read(join("docs", "spec", name))
    assert.match(text, /^## (Stability|稳定性)$/m, name + " does not declare a stability section")
    assert.match(text, /frozen|provisional/, name + " does not say whether it is frozen or provisional")
    assert.ok(text.indexOf("compatibility.md") !== -1, name + " does not point at the compatibility policy")
    assert.ok(policy.indexOf(name) !== -1, name + " is not in the compatibility policy table")
  }
})

test("the identifiers the policy prints are the ones the code emits", function () {
  const policy = read("docs/spec/compatibility.md")
  for (const id of [POLICY_VERSION, SCAN_EXECUTION_VERSION, PACK_SCHEMA]) {
    assert.ok(policy.indexOf(id) !== -1, "the policy does not mention " + id)
  }
  assert.equal(POLICY_VERSION, "agentgate.policy/v1")
  assert.equal(SCAN_EXECUTION_VERSION, "agentgate.scan-execution/v1")
  assert.equal(PACK_SCHEMA, "agentgate.evidence-pack/v1")
})

test("every versioned release or candidate has a matching upgrade note", function () {
  const released = Array.from(read("CHANGELOG.md").matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)).map(function (m) { return m[1] })
  const documented = Array.from(read("docs/operations/upgrade.md").matchAll(/^## (\d+\.\d+\.\d+)$/gm)).map(function (m) { return m[1] })
  assert.ok(released.length >= 10, "expected the released versions, found " + released.length)
  assert.deepEqual(documented.slice().sort(), released.slice().sort(),
    "the upgrade guide and the CHANGELOG disagree about documented versions")
})

test("the security policy says where to report and which versions are supported", function () {
  assert.equal(existsSync(join(ROOT, "SECURITY.md")), true, "SECURITY.md is missing")
  const security = read("SECURITY.md")
  assert.match(security, /contact@xn--5kvo87g\.com/)
  assert.ok(security.indexOf("docs/spec/compatibility.md") !== -1, "SECURITY.md does not point at the support window")
  assert.ok(security.indexOf("no bug bounty") !== -1, "the absence of a bounty should be stated, not implied")
  const policy = read("docs/spec/compatibility.md")
  assert.match(policy, /90 days/, "the support window has no number in it")
  assert.ok(policy.indexOf("latest") !== -1, "the support window does not name the tag it follows")
})
