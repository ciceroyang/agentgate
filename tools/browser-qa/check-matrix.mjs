#!/usr/bin/env node
// Read back all native job artifacts; never execute code from an artifact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const json = file => JSON.parse(readFileSync(file, 'utf8'));
function allPassed(report) {
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  assert.ok(report.checks.every(check => check.passed === true));
  assert.deepEqual(report.summary, { checks: report.checks.length, passed: report.checks.length, failed: 0 });
}
try {
  assert.equal(process.argv.length, 3, 'usage: check-matrix.mjs ARTIFACT_ROOT');
  const root = resolve(process.argv[2]);
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
    allPassed(acceptance); allPassed(browser);
    assert.deepEqual(receipt.acceptance.summary, acceptance.summary);
    assert.equal(browser.ok, true);
    assert.equal(browser.package.tarballSha256, receipt.tarball.sha256);
    assert.equal(acceptance.package.name, receipt.package.name);
    assert.equal(acceptance.package.version, receipt.package.version);
    assert.equal(browser.package.name, receipt.package.name);
    assert.equal(browser.package.version, receipt.package.version);
    assert.equal(browser.runtime.node, receipt.runtime.node);
    assert.equal(browser.runtime.platform, receipt.runtime.platform);
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
  console.log(JSON.stringify({ ok: true, identicalArtifact: true, jobs }, null, 2));
} catch (error) {
  console.error('Native matrix readback failed: ' + error.message);
  process.exitCode = 1;
}
