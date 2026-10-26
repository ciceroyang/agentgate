#!/usr/bin/env node
// Native, synthetic first-use acceptance against the exact offline-installed package.
// Usage: node check-first-use.mjs RELEASE_JSON NEW_OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createCapture } from './stream-capture.mjs';

const markers = ['SYNTHETIC_QA_ARG_SECRET', 'SYNTHETIC_QA_ENV_SECRET', 'SYNTHETIC_QA_HEADER_SECRET', 'SYNTHETIC_QA_URL_SECRET'];
const hasSecret = value => markers.some(marker => String(value).includes(marker));
const redact = value => markers.reduce((text, marker) => text.split(marker).join('[synthetic marker withheld]'), String(value));
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const save = (file, value) => writeFileSync(file, value, { flag: 'wx', mode: 0o600 });
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function within(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: check-first-use.mjs RELEASE_JSON NEW_OUTPUT_DIRECTORY');
  process.exitCode = 2;
} else {
  await main(resolve(args[0]), resolve(args[1]));
}

async function main(receiptPath, output) {
  // Refuse an existing directory rather than mixing evidence from separate runs.
  try { mkdirSync(output, { mode: 0o700 }); }
  catch (error) { console.error('Browser acceptance output could not be created: ' + error.code); process.exitCode = 1; return; }
  const checks = [], commands = [], pageErrors = [], consoleMessages = [], requests = [], violations = [];
  const result = {
    schemaVersion: 1, syntheticOnly: true,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    boundary: 'This native host only; synthetic offline-installed package acceptance, not publication, deployment, or customer validation.',
    checks, pageErrors, consoleMessages, requests, violations,
  };
  let browser, browserServer, server, serverDone, serverOutput = '', serverError = '', origin;
  const stdoutCapture = createCapture(markers), stderrCapture = createCapture(markers);
  const serverSecretExposed = () => stdoutCapture.secretExposed || stderrCapture.secretExposed;
  let currentRoute = 'setup';
  const directory = name => { const path = join(output, name); mkdirSync(path, { mode: 0o700 }); return path; };
  const home = directory('synthetic-home'), temporary = directory('temporary'), project = directory('synthetic-project');
  const downloads = directory('downloads'), screenshots = directory('screenshots');
  const appData = directory('synthetic-appdata'), localAppData = directory('synthetic-localappdata');
  const env = { PATH: process.env.PATH || '', HOME: home, USERPROFILE: home,
    APPDATA: appData, LOCALAPPDATA: localAppData, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    NO_COLOR: '1', AGENTGATE_INDEX: '' };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const preload = join(output, 'no-outbound.cjs');
  save(preload, `const deny=()=>{throw new Error('QA outbound network blocked')};
globalThis.fetch=deny;
for(const name of ['http','https']){const m=require('node:'+name);m.request=deny;m.get=deny;}
const net=require('node:net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;
require('node:tls').connect=deny;
const dns=require('node:dns');const lookup=dns.lookup.bind(dns);
dns.lookup=(host,...args)=>host==='127.0.0.1'?lookup(host,...args):deny();
for(const k of ['resolve','resolve4','resolve6']){dns[k]=deny;if(dns.promises)dns.promises[k]=deny;}
if(dns.promises)dns.promises.lookup=deny;
require('node:module').syncBuiltinESMExports();\n`);

  async function check(id, action, page) {
    currentRoute = id;
    const started = performance.now();
    try {
      const observed = await action();
      checks.push({ id, passed: true, durationMs: Math.round(performance.now() - started), observed: observed ?? null });
      return true;
    } catch (error) {
      const item = { id, passed: false, durationMs: Math.round(performance.now() - started), error: redact(error.message).slice(0, 4000) };
      if (page && !page.isClosed()) {
        try {
          // Never store a screenshot showing a failed privacy assertion's marker.
          const visible = await page.evaluate(() => document.documentElement.outerHTML + '\n' + Array.from(document.querySelectorAll('input,textarea')).map(el => el.value).join('\n'));
          if (!hasSecret(visible)) {
            const file = join(screenshots, id + '.png');
            await page.screenshot({ path: file, fullPage: true, timeout: 5000 });
            item.screenshot = 'screenshots/' + id + '.png';
          } else item.screenshotWithheld = 'Synthetic secret visible';
        } catch { item.screenshotUnavailable = true; }
      }
      checks.push(item);
      return false;
    }
  }

  try {
    const receipt = json(receiptPath);
    let entry, packageRoot;
    const accepted = await check('accepted-package-identity', () => {
      assert.equal(receipt.kind, 'verified-local-package');
      assert.equal(receipt.package?.name, '@zhiliangtech/agentgate');
      const filename = receipt.tarball?.filename;
      assert.equal(typeof filename, 'string');
      assert.equal(basename(filename), filename);
      assert.match(filename, /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/);
      const bytes = readFileSync(join(dirname(receiptPath), filename));
      assert.equal(bytes.length, receipt.tarball.bytes);
      assert.equal(digest(bytes), receipt.tarball.sha256);
      assert.equal('sha512-' + digest(bytes, 'sha512', 'base64'), receipt.tarball.integrity);
      assert.equal(receipt.acceptance?.filename, 'acceptance.json');
      const acceptanceBytes = readFileSync(join(dirname(receiptPath), 'acceptance.json'));
      assert.equal(digest(acceptanceBytes), receipt.acceptance.sha256);
      assert.equal(JSON.parse(acceptanceBytes).summary.failed, 0);
      assert.ok(isAbsolute(receipt.installation?.packageRoot));
      packageRoot = realpathSync(receipt.installation.packageRoot);
      const installed = json(join(packageRoot, 'package.json'));
      assert.equal(installed.name, receipt.package.name);
      assert.equal(installed.version, receipt.package.version);
      assert.ok(['bin/agentgate.mjs', './bin/agentgate.mjs'].includes(installed.bin?.agentgate));
      entry = realpathSync(join(packageRoot, installed.bin.agentgate));
      assert.equal(receipt.installation.reportedVersion, 'agentgate ' + installed.version);
      result.package = { name: installed.name, version: installed.version, tarballSha256: digest(bytes) };
      return result.package;
    });
    if (!accepted) throw new Error('Accepted-package identity is required before launching installed code');
    function cli(label, cliArgs) {
      const child = spawnSync(process.execPath, ['--require', preload, entry, ...cliArgs], {
        cwd: project, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      const secretExposed = hasSecret((child.stdout || '') + (child.stderr || ''));
      commands.push({ label, exitCode: child.status, signal: child.signal,
        errorCode: child.error?.code ?? null, stdout: redact(child.stdout || ''), stderr: redact(child.stderr || ''), secretExposed });
      assert.equal(secretExposed, false, label + ' exposed a synthetic secret');
      assert.equal(child.error, undefined, label + ' did not complete');
      assert.equal(child.status, 0, label + ' failed');
      return child.stdout;
    }
    assert.ok(await check('installed-node-entry-version', () => {
      assert.equal(cli('version', ['version']).trim(), 'agentgate ' + receipt.package.version);
      return { entry: 'installed bin/agentgate.mjs', version: receipt.package.version };
    }));

    mkdirSync(join(home, '.codex'));
    const codex = join(home, '.codex', 'config.toml');
    const raw = join(project, '.mcp.json');
    save(codex, ['model = "synthetic-model"', '[mcp_servers.npm_tool]',
      'command = "' + (process.platform === 'win32' ? 'npx.cmd' : 'npx') + '"',
      'args = ["-y", "pretrip-mcp@1.0.1", "--token", "' + markers[0] + '"]',
      '[mcp_servers.npm_tool.env]', 'TOKEN = "' + markers[1] + '"',
      '[mcp_servers.codex_disabled]', 'enabled = false', 'command = "npx"', 'args = ["qa-disabled-codex@9.9.9"]', '',
    ].join('\n'));
    save(raw, JSON.stringify({ mcpServers: {
      python_tool: { command: process.platform === 'win32' ? 'uvx.exe' : 'uvx', args: ['qa-fetch==1.2.3'], env: { TOKEN: markers[1] } },
      '未知工具@7.8.9': { command: 'qa-custom-wrapper', url: 'https://qa.invalid/mcp?token=' + markers[3], headers: { Authorization: markers[2] } },
      json_disabled: { enabled: false, command: 'npx', args: ['qa-disabled-json@8.8.8'] },
    } }));
    const sourceBefore = [codex, raw].map(file => digest(readFileSync(file)));
    const toolsFile = join(output, 'discovered-tools.json');
    const expected = [
      { name: 'npm_tool', package: 'pretrip-mcp', registry: 'npm', version: '1.0.1' },
      { name: 'python_tool', package: 'qa-fetch', registry: 'pypi', version: '1.2.3' },
      { name: '未知工具@7.8.9', package: null, registry: null, version: null },
    ];
    const identity = rows => rows.map(row => Object.fromEntries(['name', 'package', 'registry', 'version'].map(key => [key, row[key]]))).sort((a, b) => a.name.localeCompare(b.name));
    assert.ok(await check('installed-discovery-export', () => {
      const flags = ['discover', '--home', home, '--roots', project];
      const diagnostic = JSON.parse(cli('discover-diagnostic', [...flags, '--format', 'json']));
      assert.equal(diagnostic.incomplete, false);
      assert.equal(diagnostic.counts.sourcesRead, 2);
      assert.equal(diagnostic.counts.serversDisabled, 2);
      cli('discover-export', [...flags, '--format', 'inventory', '--out', toolsFile]);
      const text = readFileSync(toolsFile, 'utf8');
      assert.equal(hasSecret(text), false);
      const exported = JSON.parse(text).tools;
      assert.deepEqual(identity(exported), identity(expected));
      assert.deepEqual([codex, raw].map(file => digest(readFileSync(file))), sourceBefore);
      return { sourcesRead: diagnostic.counts.sourcesRead, disabled: diagnostic.counts.serversDisabled, exported: exported.length, sourceUnchanged: true };
    }));

    const serverStarted = await check('installed-loopback-server', async () => {
      server = spawn(process.execPath, ['--require', preload, entry, 'serve', '--host', '127.0.0.1', '--port', '0'], {
        cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      serverDone = new Promise(resolveDone => {
        server.once('error', error => resolveDone({ errorCode: error.code }));
        server.once('close', (code, signal) => resolveDone({ code, signal }));
      });
      server.stdout.on('data', bytes => { stdoutCapture.push(bytes); serverOutput = stdoutCapture.text; });
      server.stderr.on('data', bytes => { stderrCapture.push(bytes); serverError = stderrCapture.text; });
      server.stdout.on('end', () => { stdoutCapture.push(''); serverOutput = stdoutCapture.text; });
      server.stderr.on('end', () => { stderrCapture.push(''); serverError = stderrCapture.text; });
      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        const match = serverOutput.match(/agentgate serving (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { origin = match[1]; return { host: '127.0.0.1', port: new URL(origin).port, installedEntry: true }; }
        if (server.exitCode !== null || server.signalCode !== null) throw new Error('Installed server exited before reporting its loopback address');
        await delay(50);
      }
      throw new Error('Installed server did not report its loopback address within 15 seconds');
    });
    if (!serverStarted) throw new Error('Loopback server is required for browser acceptance');

    const require = createRequire(import.meta.url);
    const playwright = process.env.AGENTGATE_QA_PLAYWRIGHT_ROOT ? require(resolve(process.env.AGENTGATE_QA_PLAYWRIGHT_ROOT)) : require('playwright');
    result.runtime.playwright = process.env.AGENTGATE_QA_PLAYWRIGHT_ROOT
      ? require(join(resolve(process.env.AGENTGATE_QA_PLAYWRIGHT_ROOT), 'package.json')).version
      : require('playwright/package.json').version;
    // BrowserServer exposes an owned process and a force-close operation; it never
    // connects to the user's browser, and its automation socket is loopback only.
    browserServer = await playwright.chromium.launchServer({ headless: true, host: '127.0.0.1', env, timeout: 30000,
      ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    });
    browser = await playwright.chromium.connect(browserServer.wsEndpoint(), { timeout: 30000 });
    result.runtime.browser = await browser.version();
    result.runtime.browserSource = process.env.CHROME_BIN ? 'explicit-existing-browser' : 'playwright-chromium';
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    // Playwright's built-in SW blocker reads navigator.serviceWorker in opaque
    // sandboxed report frames, producing its own SecurityError. Preserve those
    // product sandbox restrictions and block registrations only where accessible.
    await context.addInitScript(() => {
      let workers;
      try { workers = navigator.serviceWorker; }
      catch (error) { if (error.name === 'SecurityError') return; throw error; }
      if (workers) Object.defineProperty(workers, 'register', { value: () => {
        throw new Error('QA service worker registration blocked');
      } });
    });
    context.on('serviceworker', () => violations.push({ route: currentRoute, kind: 'unexpected-service-worker' }));
    context.setDefaultTimeout(10000);
    const allowedPaths = new Set(['/inventory.html', '/en/inventory.html', '/inventory-page.mjs', '/inventory.mjs', '/inventory-report.mjs', '/favicon.svg', '/favicon.ico']);
    await context.route('**/*', async route => {
      const request = route.request();
      const secretExposed = hasSecret(request.url() + JSON.stringify(request.headers()) + (request.postData() || ''));
      const url = new URL(request.url());
      const workerRequest = request.serviceWorker() !== null || request.headers()['service-worker'] !== undefined;
      const allowed = !secretExposed && !workerRequest && url.origin === origin && request.method() === 'GET' && allowedPaths.has(url.pathname) && !url.search;
      requests.push({ route: currentRoute, allowed, method: request.method(), path: allowed ? url.pathname : '[blocked]', secretExposed });
      if (!allowed) { violations.push({ route: currentRoute, kind: secretExposed ? 'secret-in-request' : 'non-static-or-non-loopback-request' }); await route.abort(); }
      else await route.continue();
    });
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
      violations.push({ route: currentRoute, kind: 'unexpected-websocket' }); socket.close();
    });

    async function pagePrivacy(page) {
      const values = await page.evaluate(() => ({ html: document.documentElement.outerHTML,
        input: document.getElementById('inventory-input').value,
        local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) }));
      assert.equal(hasSecret(JSON.stringify(values)), false, 'Synthetic secret reached browser-visible state');
      assert.equal(values.local, '{}', 'Inventory flow persisted localStorage');
      assert.equal(values.session, '{}', 'Inventory flow persisted sessionStorage');
    }
    async function upload(page, file) {
      await page.locator('#inventory-file').setInputFiles(file);
      await page.waitForFunction(() => document.getElementById('inventory-form').getAttribute('aria-busy') === 'false');
    }
    async function compare(page, rows) {
      await page.locator('#compare-button').click();
      await page.locator('#results-section').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#page-error').isVisible(), false);
      assert.equal(await page.locator('.item-card').count(), rows.length);
      for (const row of rows) {
        const card = page.locator('.item-card').filter({ has: page.locator('h3', { hasText: row.name }) });
        assert.equal(await card.count(), 1);
        assert.equal(await card.locator('input[data-version-for]').inputValue(), row.version || '');
      }
      const matched = await page.locator('#report-summary p').nth(1).locator('b').textContent();
      assert.equal(matched, '0', 'Sample index must not assert evidence matches');
    }
    async function download(page, label, lang, rows, demo = false) {
      await page.locator('#download-button').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#download-button').isEnabled(), true);
      const before = await page.locator('#report-preview').getAttribute('srcdoc');
      const event = page.waitForEvent('download');
      await page.locator('#download-button').click();
      const file = await event;
      assert.match(file.suggestedFilename(), /^agentgate-inventory-(?:demo-)?\d{4}-\d{2}-\d{2}\.html$/);
      const path = join(downloads, label + '.html');
      await file.saveAs(path);
      const html = readFileSync(path, 'utf8');
      assert.equal(html, before, 'Downloaded bytes differ from current preview');
      assert.equal(hasSecret(html), false, 'Synthetic secret reached report');
      const parsed = await page.evaluate(text => {
        const doc = new DOMParser().parseFromString(text, 'text/html');
        return { lang: doc.documentElement.lang, scripts: doc.querySelectorAll('script').length,
          resources: Array.from(doc.querySelectorAll('[src],[href]')).map(el => el.getAttribute('src') || el.getAttribute('href')),
          text: doc.body.textContent, matched: doc.querySelectorAll('.summary b')[1]?.textContent,
          rows: Array.from(doc.querySelectorAll('article.item')).map(item => ({ title: item.querySelector('h3').textContent,
            values: Array.from(item.querySelectorAll('.identity > section:first-child td')).map(el => el.textContent) })) };
      }, html);
      assert.equal(parsed.lang, lang === 'en' ? 'en' : 'zh-CN');
      assert.equal(parsed.scripts, 0);
      assert.deepEqual(parsed.resources, [], 'Downloaded report has external or linked resources');
      assert.equal(parsed.matched, '0');
      assert.ok(parsed.text.includes(lang === 'en' ? 'Historical sample snapshot' : '样本历史快照'));
      if (demo) assert.ok(parsed.text.includes(lang === 'en' ? 'Demonstration report' : '演示报告'));
      if (rows) {
        assert.equal(parsed.rows.length, rows.length);
        for (const row of rows) {
          const found = parsed.rows.find(item => item.values[0] === row.name);
          assert.ok(found, 'Report lost an inventory identity');
          if (row.package !== null) assert.equal(found.values[2], row.package);
          else assert.ok(['未提供', 'Not provided'].includes(found.values[2]), 'Unknown package was guessed');
          if (row.registry !== null) assert.equal(found.values[3], row.registry);
          if (row.version !== null) assert.equal(found.values[4], row.version);
          else assert.ok(/未填写|Not provided/.test(found.values[4]), 'Unknown version was guessed');
        }
        assert.ok(!parsed.text.includes('qa-disabled-'));
      }
      await pagePrivacy(page);
      return { download: 'downloads/' + label + '.html', bytes: Buffer.byteLength(html), items: parsed.rows.length,
        language: parsed.lang, sampleMatched: Number(parsed.matched), standalone: true, previewEqualsDownload: true };
    }

    for (const lang of ['zh', 'en']) {
      const page = await context.newPage();
      page.on('pageerror', error => pageErrors.push({ route: currentRoute, message: redact(error.message).slice(0, 2000), secretExposed: hasSecret(error.message) }));
      page.on('console', message => {
        const text = message.text();
        consoleMessages.push({ route: currentRoute, type: message.type(), message: redact(text).slice(0, 2000), secretExposed: hasSecret(text) });
      });
      const loaded = await check(lang + '-load', async () => {
        const response = await page.goto(origin + (lang === 'en' ? '/en/inventory.html' : '/inventory.html'), { waitUntil: 'networkidle', timeout: 15000 });
        assert.equal(response.status(), 200);
        await page.waitForFunction(() => !document.getElementById('example-button').disabled);
        assert.ok(await page.locator('#index-status').evaluate(el => el.classList.contains('sample')));
        await pagePrivacy(page);
        return { language: await page.locator('html').getAttribute('lang'), sampleIndex: true };
      }, page);
      if (!loaded) { await page.close(); continue; }
      await check(lang + '-demo-download', async () => {
        await page.locator('#example-button').click();
        assert.equal(await page.locator('#demo-note').isVisible(), true);
        return download(page, lang + '-demo', lang, null, true);
      }, page);
      await check(lang + '-discovery-import-download', async () => {
        await upload(page, toolsFile);
        assert.equal(await page.locator('#page-error').isVisible(), false);
        assert.deepEqual(identity(JSON.parse(await page.locator('#inventory-input').inputValue()).tools), identity(expected));
        assert.equal(await page.locator('#download-button').isEnabled(), false, 'Import did not invalidate old download');
        await compare(page, expected);
        await page.locator('#preview-button').click();
        return download(page, lang + '-discovered', lang, expected);
      }, page);
      for (const [kind, name, bytes] of [
        ['mcp-json', 'raw-config.json', readFileSync(raw)],
        ['codex-text', 'raw-codex.txt', readFileSync(codex)],
      ]) await check(lang + '-reject-' + kind + '-recover', async () => {
        const previous = await page.locator('#inventory-input').inputValue();
        await upload(page, { name, mimeType: 'text/plain', buffer: bytes });
        assert.equal(await page.locator('#page-error').isVisible(), true, 'Raw config was accepted');
        assert.equal(await page.locator('#inventory-input').inputValue(), previous, 'Raw config replaced inventory text');
        assert.equal(await page.locator('#inventory-file').inputValue(), '');
        assert.equal(await page.locator('#download-button').isEnabled(), false);
        assert.equal(await page.locator('#report-preview').getAttribute('srcdoc'), null);
        await pagePrivacy(page);
        await upload(page, toolsFile);
        assert.equal(await page.locator('#page-error').isVisible(), false);
        await compare(page, expected);
        await page.locator('#preview-button').click();
        return download(page, lang + '-recovered-' + kind, lang, expected);
      }, page);
      for (const endian of ['le', 'be']) await check(lang + '-utf16' + endian + '-download', async () => {
        const text = readFileSync(toolsFile, 'utf8');
        const payload = Buffer.from(text, 'utf16le');
        if (endian === 'be') payload.swap16();
        const bytes = Buffer.concat([Buffer.from(endian === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), payload]);
        await upload(page, { name: 'unicode-tools-' + endian + '.json', mimeType: 'application/json', buffer: bytes });
        assert.equal(await page.locator('#page-error').isVisible(), false);
        assert.deepEqual(identity(JSON.parse(await page.locator('#inventory-input').inputValue()).tools), identity(expected));
        await compare(page, expected);
        await page.locator('#preview-button').click();
        return download(page, lang + '-utf16' + endian, lang, expected);
      }, page);
      await check(lang + '-reset-and-no-upload', async () => {
        await page.locator('#reset-button').click();
        assert.equal(await page.locator('#inventory-input').inputValue(), '');
        assert.equal(await page.locator('#report-preview').getAttribute('srcdoc'), null);
        assert.equal(await page.locator('#download-button').isEnabled(), false);
        await pagePrivacy(page);
        return { resetCleared: true, storagePersisted: false };
      }, page);
      await page.close();
    }
    await check('network-console-and-source-privacy', () => {
      assert.equal(context.serviceWorkers().length, 0, 'Unexpected service worker exists');
      assert.deepEqual(violations, []);
      assert.deepEqual(pageErrors, [], 'Browser page errors were recorded');
      assert.equal(consoleMessages.some(item => item.secretExposed), false);
      assert.equal(serverSecretExposed(), false);
      assert.deepEqual([codex, raw].map(file => digest(readFileSync(file))), sourceBefore);
      assert.equal(requests.some(item => item.route !== 'zh-load' && item.route !== 'en-load'), false, 'Inventory interaction made a network request');
      return { requests: requests.length, violations: violations.length, pageErrors: pageErrors.length, sourceUnchanged: true };
    });
  } catch (error) {
    checks.push({ id: 'acceptance-prerequisite', passed: false, error: redact(error.message).slice(0, 4000) });
  } finally {
    if (browserServer) await check('browser-stopped', async () => {
      let forced = false;
      try { await within(browserServer.close(), 10000, 'Browser close'); }
      catch { forced = true; await within(browserServer.kill(), 5000, 'Owned browser kill'); }
      const child = browserServer.process();
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned browser remains running');
      return { stopped: true, forced };
    });
    if (server) await check('server-stopped', async () => {
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
      let stopped;
      try { stopped = await within(serverDone, 5000, 'Server stop'); }
      catch { server.kill('SIGKILL'); stopped = await within(serverDone, 2000, 'Owned server kill'); }
      assert.ok(stopped, 'Owned loopback server did not stop');
      return stopped;
    });
    await check('final-diagnostic-privacy', () => {
      assert.equal(commands.some(item => item.secretExposed), false);
      assert.equal(consoleMessages.some(item => item.secretExposed), false);
      assert.equal(serverSecretExposed(), false);
      assert.deepEqual(violations, []);
      assert.deepEqual(pageErrors, []);
      return { syntheticSecretExposed: false, pageErrors: pageErrors.length, blockedRequests: violations.length };
    });
    save(join(output, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
    save(join(output, 'server.log'), redact(serverOutput + '\n' + serverError));
    result.summary = { checks: checks.length, passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length };
    result.ok = result.summary.failed === 0;
    save(join(output, 'browser-acceptance.json'), JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ok: result.ok, runtime: result.runtime, summary: result.summary, receipt: join(output, 'browser-acceptance.json') }) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  }
}
