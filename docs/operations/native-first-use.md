# Native installed-package acceptance

This is an engineering acceptance procedure for an **unreleased candidate**, not a
claim that the public npm package already contains these changes. The dedicated
`codex/agentgate-platform-acceptance-20261026` branch does not merge, publish, or deploy.

## What the workflow actually exercises

`.github/workflows/first-use.yml` uses native Ubuntu and Windows runners with Node 20
and Node 24. Each job builds a tarball, verifies its bytes, installs that exact local
tarball with an empty npm cache, offline and with install scripts disabled, and calls
the generated command launcher. The candidate and installation directory contains
Chinese characters and a space. Runtime versions, archive digests and check results
come from the job's receipts; inspect the job, not merely the workflow definition.
Windows checkout preserves repository line endings. A separate readback job verifies
all native receipts and actual archive bytes, and requires one identical tarball hash
across the matrix; passing different platform-local builds is not enough.

The browser tool uses that installed package, a temporary synthetic home, and an
independent headless Chromium. For both Chinese and English it checks:

- First-use example to preview and downloaded HTML, clearly marked demonstration.
- Real CLI discovery of **synthetic** Codex/MCP configuration to a sanitized tools
  export, then browser file import, comparison, preview, download and byte readback.
- npm/pypi identity and declared versions, unknown identities, disabled entries,
  and a sample index that must not claim evidence matches.
- Raw configuration refusal followed by successful valid-file import without a refresh.
- UTF-16LE and UTF-16BE imports, preview invalidation and reset.
- Script-free standalone reports, no synthetic secrets in reports, page state or
  diagnostics, and no application requests beyond the allowed loopback static files.

The browser test does not use the operator's browser profile, real tool configuration,
credentials, customers, production service or external tool servers. Test tooling is
private under `tools/browser-qa` and forbidden by the package-content gate.

## Windows installation boundary

Native testing found that npm-generated `.cmd` launchers break when their installation
directory contains `&`: the shim expands its directory in an unquoted assignment before
AgentGate starts. The original failing CI record must remain a failure. The packaging
gate now refuses `&` and conservatively `%` in the candidate path with an actionable
error; it does not modify npm's generated shim or replace its acceptance with direct
Node execution. A directory with Chinese characters and spaces remains in the native
positive test. This is not a claim of compatibility with every Windows path.

For a candidate trial, select a writable, private user directory whose full path does
not contain `&` or `%`. Install the verified artifact there using `npm.cmd install
--ignore-scripts --no-audit --no-fund <candidate.tgz>`, then use the generated
`.\node_modules\.bin\agentgate.cmd` entry. PowerShell can call the `.cmd` explicitly;
do not change execution policy to enable an npm-generated `.ps1` file.

On POSIX, output mode must still be `0600`. Windows uses inherited directory ACLs:
the no-overwrite check is enforced, but a POSIX mode value is **not** accepted as proof
of Windows ACL privacy. Put real reports in a private directory under the company's
normal access controls. This workflow does not change authentication or ACL settings.

## End-user route being validated

1. Start `agentgate serve --port 0` using the installed command entry and open the
   printed loopback inventory URL; the English page is `/en/inventory.html`.
2. Try the example first if no inventory exists. It is a demonstration, not customer data.
3. For real configuration, use `agentgate discover --format inventory --out tools.json`
   locally, with explicit `--home` / `--roots` if needed. Do not upload raw MCP JSON,
   Codex TOML, environment values or credentials to the web page.
4. Import the exported tools file, compare, inspect uncertain entries and declared
   versions, preview and download the standalone report. A completed report is not
   the same as every tool being independently verified.

## Reproduction and evidence

Use a new output directory on every attempt. The packing script emits `release.json`,
`acceptance.json`, phase journals and the exact tarball. Browser reproduction:

```sh
npm ci --prefix tools/browser-qa --ignore-scripts --no-audit --no-fund
node tools/browser-qa/node_modules/playwright/cli.js install chromium
node tools/browser-qa/check-first-use.mjs /absolute/path/release.json /new/output/browser
```

Linux CI uses its existing Chrome when available, otherwise installs Playwright's
Chromium and system libraries on the disposable runner. Windows uses Playwright Chromium. Browser
receipts contain the actual OS, architecture, Node, Playwright and Chromium versions,
individual assertions, downloaded report metadata and cleanup results. Failures exit
nonzero. CI artifacts are retained for seven days; persist a reviewed summary and
digests before relying on them long term. A forced workflow cancellation can prevent
the final evidence/cleanup step; do not label an interrupted run successful.

Native Windows Server 2022 / Ubuntu 24.04 evidence is not a Windows 11, all Linux
distributions, all browsers, corporate proxy, endpoint-security or arbitrary filesystem
certification. No real customer trial or willingness-to-pay evidence is produced here.
