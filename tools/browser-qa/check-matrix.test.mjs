import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { scratchDir } from '../../test/tmpdir.mjs';
import { verifyNativeMatrix } from './check-matrix.mjs';

// These are synthetic receipts and an empty tar, not native installation evidence.
// Keep the literal contract independent of the verifier's own expected-ID lists.
const CLI_IDS = [
  'missing-explicit-index', 'required-evidence-absent', 'valid-required-evidence',
  'stricter-policy', 'same-alias-two-tools', 'python-identity', 'same-count-risk-change',
  'codex-config', 'discovery-credential-boundary', 'cli-discovery-inventory-handoff',
  'cli-inventory-json-readback', 'cli-inventory-html-readback', 'cli-default-sample-not-confirmed',
  'cli-output-no-implicit-overwrite', 'cli-invalid-source-stays-incomplete',
  'cli-windows-launcher-declarations', 'cli-leading-option-values-stay-private',
  'cli-credential-boundary-end-to-end', 'cli-inventory-file-encodings',
  'cli-inventory-raw-config-refusal',
];
const BROWSER_IDS = [
  'accepted-package-identity', 'installed-node-entry-version', 'installed-discovery-export',
  'installed-loopback-server',
  ...['zh', 'en'].flatMap(lang => [
    'load', 'demo-download', 'discovery-import-download', 'reject-mcp-json-recover',
    'reject-codex-text-recover', 'utf16le-download', 'utf16be-download', 'reset-and-no-upload',
  ].map(id => lang + '-' + id)),
  'network-console-and-source-privacy', 'browser-stopped', 'server-stopped',
  'final-diagnostic-privacy',
];
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const summary = checks => ({ checks: checks.length, passed: checks.filter(check => check.passed === true).length,
  failed: checks.filter(check => check.passed !== true).length });
const passedReport = ids => {
  const checks = ids.map(id => ({ id, passed: true }));
  return { syntheticOnly: true, checks, summary: summary(checks) };
};

function fixture(edit = () => {}) {
  const root = scratchDir('ag-synthetic-matrix-');
  const jobs = [];
  for (const platform of ['linux', 'win32']) for (const node of ['v20.20.2', 'v24.19.0']) {
    const runtime = { node, platform, arch: 'x64' };
    const pkg = { name: '@zhiliangtech/agentgate', version: '0.0.0-synthetic' };
    const bytes = gzipSync(Buffer.alloc(1024));
    const acceptance = { ...passedReport(CLI_IDS), package: { ...pkg }, runtime: { ...runtime } };
    const browser = { ...passedReport(BROWSER_IDS), ok: true,
      package: { ...pkg, tarballSha256: hash(bytes) },
      runtime: { ...runtime, browser: 'synthetic-browser-not-launched', playwright: 'synthetic' } };
    const receipt = { syntheticOnly: true, kind: 'verified-local-package', package: { ...pkg },
      runtime: { ...runtime, npm: { version: 'synthetic-npm-not-launched' } },
      tarball: { filename: 'synthetic-agentgate-0.0.0.tgz', bytes: bytes.length,
        sha256: hash(bytes), integrity: 'sha512-' + hash(bytes, 'sha512', 'base64') },
      acceptance: { filename: 'acceptance.json', sha256: hash(encode(acceptance)), summary: acceptance.summary } };
    jobs.push({ receipt, acceptance, browser, bytes });
  }
  edit(jobs);
  jobs.forEach((job, index) => {
    const base = join(root, 'synthetic-job-' + index), candidate = join(base, '中文 candidate');
    mkdirSync(candidate, { recursive: true });
    mkdirSync(join(base, 'browser'));
    // Rebind changed acceptance bytes so negative tests exercise the intended
    // semantic check, not an incidental hash mismatch.
    job.receipt.acceptance = { ...job.receipt.acceptance,
      sha256: hash(encode(job.acceptance)), summary: job.acceptance.summary };
    writeFileSync(join(candidate, job.receipt.tarball.filename), job.bytes);
    writeFileSync(join(candidate, 'acceptance.json'), encode(job.acceptance));
    writeFileSync(join(candidate, 'release.json'), encode(job.receipt));
    writeFileSync(join(base, 'browser', 'browser-acceptance.json'), encode(job.browser));
  });
  return root;
}

test('synthetic complete matrix accepts identical bytes without executing archive code', () => {
  const result = verifyNativeMatrix(fixture());
  assert.equal(result.ok, true);
  assert.equal(result.identicalArtifact, true);
  assert.deepEqual(result.jobs.map(job => job.key).sort(), ['linux-20', 'linux-24', 'win32-20', 'win32-24']);
  assert.equal(new Set(result.jobs.map(job => job.tarballSha256)).size, 1);
  assert.ok(result.jobs.every(job => job.package.version === '0.0.0-synthetic'));
});

for (const [name, field] of [['CLI', 'acceptance'], ['browser', 'browser']]) {
  for (const [caseName, change] of [
    ['a single arbitrary passing check', report => { report.checks = [{ id: 'synthetic-shortcut', passed: true }]; }],
    ['a missing required check', report => { report.checks.pop(); }],
    ['a duplicate replacing a required check', report => { report.checks[report.checks.length - 1] = { ...report.checks[0] }; }],
    ['an additional unknown check', report => { report.checks.push({ id: 'synthetic-unknown-check', passed: true }); }],
    ['an empty check list', report => { report.checks = []; }],
    ['a non-string check ID', report => { report.checks[0].id = null; }],
  ]) test(`synthetic ${name} receipt rejects ${caseName} despite self-consistent passing counts`, () => {
    const root = fixture(jobs => {
      const report = jobs[0][field];
      change(report);
      report.summary = summary(report.checks);
    });
    assert.throws(() => verifyNativeMatrix(root));
  });

  test(`synthetic ${name} receipt accepts the complete check set in a different order`, () => {
    const root = fixture(jobs => { jobs[0][field].checks.reverse(); });
    assert.equal(verifyNativeMatrix(root).ok, true);
  });

  test(`synthetic ${name} receipt rejects a failed check even when its summary claims success`, () => {
    const root = fixture(jobs => { jobs[0][field].checks[0].passed = false; });
    assert.throws(() => verifyNativeMatrix(root));
  });

  test(`synthetic ${name} receipt rejects an inconsistent summary`, () => {
    const root = fixture(jobs => { jobs[0][field].summary.checks += 1; });
    assert.throws(() => verifyNativeMatrix(root));
  });

  for (const [key, value] of [['node', 'v20.99.0'], ['platform', 'win32'], ['arch', 'arm64']]) {
    test(`synthetic ${name} receipt rejects ${key} differing from the release runtime`, () => {
      const root = fixture(jobs => { jobs[0][field].runtime[key] = value; });
      assert.throws(() => verifyNativeMatrix(root), new RegExp(`${name} runtime ${key}`));
    });
    test(`synthetic ${name} receipt rejects a missing runtime ${key}`, () => {
      const root = fixture(jobs => { delete jobs[0][field].runtime[key]; });
      assert.throws(() => verifyNativeMatrix(root), new RegExp(`${name} runtime ${key}`));
    });
  }
}

test('synthetic matrix rejects a missing native job', () => {
  assert.throws(() => verifyNativeMatrix(fixture(jobs => { jobs.pop(); })));
});
test('synthetic matrix rejects a duplicate native job replacing a required combination', () => {
  assert.throws(() => verifyNativeMatrix(fixture(jobs => { jobs[3] = structuredClone(jobs[0]); })));
});
test('synthetic matrix rejects different tarball bytes even when each receipt hash is correct', () => {
  const root = fixture(jobs => {
    const job = jobs[0];
    job.bytes = gzipSync(Buffer.alloc(2048));
    job.receipt.tarball = { ...job.receipt.tarball, bytes: job.bytes.length,
      sha256: hash(job.bytes), integrity: 'sha512-' + hash(job.bytes, 'sha512', 'base64') };
    job.browser.package.tarballSha256 = job.receipt.tarball.sha256;
  });
  assert.throws(() => verifyNativeMatrix(root), /different tarball bytes/);
});
test('synthetic matrix rejects bytes altered without updating the tarball receipt', () => {
  assert.throws(() => verifyNativeMatrix(fixture(jobs => { jobs[0].bytes = Buffer.from('synthetic-tampered-archive'); })));
});
test('synthetic matrix rejects a browser report tied to a different archive', () => {
  assert.throws(() => verifyNativeMatrix(fixture(jobs => { jobs[0].browser.package.tarballSha256 = '0'.repeat(64); })));
});
