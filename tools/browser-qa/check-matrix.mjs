#!/usr/bin/env node
// Read back all native job artifacts; never execute code from an artifact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const json = file => JSON.parse(readFileSync(file, 'utf8'));

// Frozen acceptance contract for this candidate. Adding/removing a producer check
// requires an explicit update here; a shortened all-green receipt is not complete.
const CLI_CHECK_IDS = Object.freeze([
  'missing-explicit-index', 'required-evidence-absent', 'valid-required-evidence',
  'stricter-policy', 'same-alias-two-tools', 'python-identity', 'same-count-risk-change',
  'codex-config', 'discovery-credential-boundary', 'cli-discovery-inventory-handoff',
  'cli-inventory-json-readback', 'cli-inventory-html-readback', 'cli-default-sample-not-confirmed',
  'cli-output-no-implicit-overwrite', 'cli-invalid-source-stays-incomplete',
  'cli-windows-launcher-declarations', 'cli-leading-option-values-stay-private',
  'cli-credential-boundary-end-to-end', 'cli-inventory-file-encodings',
  'cli-inventory-raw-config-refusal',
]);
const BROWSER_CHECK_IDS = Object.freeze([
  'accepted-package-identity', 'installed-node-entry-version', 'installed-discovery-export',
  'installed-loopback-server',
  ...['zh', 'en'].flatMap(lang => [
    'load', 'demo-download', 'discovery-import-download', 'reject-mcp-json-recover',
    'reject-codex-text-recover', 'utf16le-download', 'utf16be-download', 'reset-and-no-upload',
  ].map(id => lang + '-' + id)),
  'network-console-and-source-privacy', 'browser-stopped', 'server-stopped',
  'final-diagnostic-privacy',
]);

function allPassed(report, expectedIds, label) {
  assert.ok(Array.isArray(report.checks), `${label} checks must be an array`);
  assert.ok(report.checks.every(check => check && typeof check.id === 'string'), `${label} check IDs must be strings`);
  const ids = report.checks.map(check => check.id);
  assert.equal(new Set(ids).size, ids.length, `${label} check IDs must be unique`);
  assert.deepEqual([...ids].sort(), [...expectedIds].sort(), `${label} required check ID set differs`);
  assert.ok(report.checks.every(check => check.passed === true), `${label} contains a non-passing check`);
  assert.deepEqual(report.summary, { checks: report.checks.length, passed: report.checks.length, failed: 0 });
}

function requireSameRuntime(actual, expected, label) {
  for (const field of ['node', 'platform', 'arch']) {
    assert.equal(typeof expected?.[field], 'string', `release runtime ${field} must be present`);
    assert.notEqual(expected[field], '', `release runtime ${field} must not be empty`);
    assert.equal(actual?.[field], expected[field], `${label} runtime ${field} differs from release`);
  }
}

export function verifyNativeMatrix(artifactRoot) {
  const root = resolve(artifactRoot);
  const jobs = [];
  for (const folder of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory())) {
    const base = join(root, folder.name), candidate = join(base, '中文 candidate');
    const receipt = json(join(candidate, 'release.json'));
    assert.equal(receipt.kind, 'verified-local-package');
    assert.match(receipt.tarball.filename, /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/);
    const bytes = readFileSync(join(candidate, receipt.tarball.filename));
    assert.equal(hash(bytes), receipt.tarball.sha256);
    assert.equal('sha512-' + hash(bytes, 'sha512', 'base64'), receipt.tarball.integrity);
    assert.equal(bytes.length, receipt.tarball.bytes);
    const acceptanceBytes = readFileSync(join(candidate, 'acceptance.json'));
    assert.equal(hash(acceptanceBytes), receipt.acceptance.sha256);
    const acceptance = JSON.parse(acceptanceBytes), browser = json(join(base, 'browser', 'browser-acceptance.json'));
    allPassed(acceptance, CLI_CHECK_IDS, 'CLI');
    allPassed(browser, BROWSER_CHECK_IDS, 'browser');
    assert.deepEqual(receipt.acceptance.summary, acceptance.summary);
    assert.equal(browser.ok, true);
    assert.equal(browser.package.tarballSha256, receipt.tarball.sha256);
    assert.equal(acceptance.package.name, receipt.package.name);
    assert.equal(acceptance.package.version, receipt.package.version);
    assert.equal(browser.package.name, receipt.package.name);
    assert.equal(browser.package.version, receipt.package.version);
    requireSameRuntime(acceptance.runtime, receipt.runtime, 'CLI');
    requireSameRuntime(browser.runtime, receipt.runtime, 'browser');
    assert.equal(receipt.runtime.arch, 'x64');
    const major = receipt.runtime.node.match(/^v(20|24)\./)?.[1];
    assert.ok(major);
    jobs.push({ key: receipt.runtime.platform + '-' + major, node: receipt.runtime.node,
      npm: receipt.runtime.npm.version, browser: browser.runtime.browser,
      cli: acceptance.summary, web: browser.summary, package: receipt.package,
      tarballSha256: receipt.tarball.sha256, bytes: bytes.length });
  }
  assert.deepEqual(jobs.map(job => job.key).sort(), ['linux-20', 'linux-24', 'win32-20', 'win32-24']);
  assert.equal(new Set(jobs.map(job => JSON.stringify(job.package))).size, 1, 'native jobs tested different package identities');
  assert.equal(new Set(jobs.map(job => job.tarballSha256)).size, 1, 'native jobs tested different tarball bytes');
  return { ok: true, identicalArtifact: true, jobs };
}

// Importing this module never runs the CLI. Resolve invocation aliases such as
// macOS /tmp -> /private/tmp so a direct invocation cannot silently skip the gate.
let invokedFile;
try { if (process.argv[1]) invokedFile = realpathSync(process.argv[1]); } catch {}
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'usage: check-matrix.mjs ARTIFACT_ROOT');
    console.log(JSON.stringify(verifyNativeMatrix(process.argv[2]), null, 2));
  } catch (error) {
    console.error('Native matrix readback failed: ' + error.message);
    process.exitCode = 1;
  }
}
