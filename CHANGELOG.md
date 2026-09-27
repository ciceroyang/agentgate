# Changelog

All notable changes to this package. Dated versions describe shipped releases; a section marked
Unreleased is a local candidate, not registry availability. The tarball and tag must agree with
the version, and `scripts/release-check.mjs` refuses a release whose section is missing.

## [0.6.0] - 2026-09-27

This minor release contains fixes that are not included in the 0.5.0 package.
Follow the [upgrade guide](docs/operations/upgrade.md#060) before switching an existing gate or
watch archive; publication and public-package readback are separate steps.

- Fail closed when required indexed evidence is absent; reject invalid or sample indexes and
  match local npm evidence by registry, name and exact version. Named scanner requirements now
  preserve the whole-execution gate, including output/consistency validation. The Action accepts
  an explicit evidence index.
- Bind manifest/audit caches to source identity, repository revision, content and scanner code;
  expire observations rather than renewing their timestamps. Old cache formats are re-read.
  Parse supported TOML package tables without borrowing names or versions from other tables.
- Preserve discovery identity across registries and aliases; add a credential-free inventory JSON
  export. Watch fingerprints now cover findings, content evidence and scanner identity while
  retaining only hashes of private material.
- Read supported Codex MCP TOML tables without starting configured tools. Omit explicitly disabled
  tools from inventory exports while retaining them in diagnostics; report unsupported shapes as
  incomplete. Alias-only identities remain explicit unknowns, never inferred package versions.
- Log allowed batch calls and each whole-batch refusal, withhold proxy startup arguments, and
  require actual decision records and nonempty archives before claiming evidence-pack coverage.
- Check PyPI withdrawal at the declared-version file level; attribute install-script findings to
  the hook that references them.
- Stop Pages deployment on collection failure instead of substituting a sample. Support subpath
  deployment, label samples, bind displayed diffs to exact non-sample index bytes, and narrow
  historical-chain claims to internal consistency. Help no longer triggers collection.
- Include release unit tests in the default suite and release-content checks in CI. These changes
  are not a deployment or a claim of enterprise readiness; see the
  [trust-hardening handoff](docs/operations/trust-hardening.md).
- Check version consistency across npm, MCP registry and plugin manifests. Add `npm run test:package`
  to accept an extracted tarball with synthetic buyer-facing failure cases, including a successful
  evidence-backed pass. The publish workflow now publishes that same tarball after checking its
  digest, instead of repacking the working directory. Include this changelog in the installed package.

### Breaking

- Discovery text now includes the registry prefix; scripts consuming the old bare package text
  must migrate. If any exported entry has only an alias, default output is inventory JSON, even
  when the output filename ends in `.txt`. Use `--format inventory` for a stable JSON handoff.
  The inventory JSON export preserves package coordinates but does not carry full
  discovery diagnostics: retain the full discovery JSON when reviewing sources and alias conflicts.
- Invalid, absent or incomplete required evidence no longer passes `check`; the provisional pack
  requires nonempty archives and actual gateway decisions for the corresponding evidence classes.
  Existing files remain readable, but previously optimistic outcomes can become incomplete.
- The first watch capture after upgrading from the old projection can report a baseline identity
  change. Preserve the original archive; see [upgrade instructions](docs/operations/upgrade.md).

## [0.5.0] - 2026-09-21

- A file the published package does not ship is now a finding instead of a gap. `registryProvenance`
  marked the evidence incomplete whenever a hook script could not be read, so
  `@yagyeshvyas/vibeguard` — whose manifest declares `"postinstall": "node scripts/postinstall.js"`
  while the tarball contains no such file — was recorded as `install-hook-script-unavailable`
  (unknown) with `complete: false`. We had asked both unpkg and jsdelivr and both answered. A
  checked absence is knowledge, the same way a repository tree with no manifest in it is; the rule
  now says so, and the finding is what is actually true: `install-hook-script-missing-from-package`
  (high), with evidence that is complete. A CDN that never answered, or a ref this step chose not
  to fetch, still leaves the evidence incomplete — those are worth retrying, and this one is not.

- A hook script we could not read now says which of three things happened. `fetchHookScript`
  returned `null` for a file the package does not ship, for a CDN that never answered, and for a
  path this step refused to request — one word, `install-hook-script-unavailable`, for all three.
  The first is knowledge about the package; the second is knowledge about this run and is worth
  retrying; the third is this build's own choice, and refs past the five-per-package cap now say
  `hook-script-not-fetched` rather than borrowing the word for a missing file. The reason travels
  into the finding's evidence and into the provenance digest, so a recorded review covers it.

- The index carries the audit's own reason for a package it could not read, instead of one word for
  both cases. `auditReason` mapped every `metadata-unavailable` to `package-metadata-unavailable`,
  so the published coverage summary still merged "the registry has no such package" with "this run
  could not reach the registry" — the two facts the audit had just started telling apart. An audit
  written before it recorded a reason still gets the old word rather than silence.

- `agentgate refresh` hands `--audit` to `build-index`. It did not, so every scheduled run rebuilt
  the published index without the package audit and the repository records fell back to "a package
  is declared here" — 6,199 audited packages' worth of evidence, dropped on a four-hourly timer with
  no error and no log line. The artifact was on disk the whole time. This is the quiet version of
  the mistake the rest of this section is about: not a wrong claim, but a capability that exists in
  the code and never reaches the file anyone reads.

- A package we could not get metadata for now says which of two different things happened.
  `fetchNpmDocument` and `fetchPypiDocument` returned `null` for every failure, so a 404
  ("the registry does not have this package") and a timeout or a 429 ("this run could not reach
  the registry") arrived at the record as the same `metadata-unavailable` with no reason at all.
  The first is a fact about the package; the second is a fact about the run. Merging them meant the
  published file could not be used to tell a wrong coordinate from a failed fetch — the same shape
  of mistake as `no-package-declared-in-repository` below, in a field with a wider blast radius.
  The fetch functions keep their existing signatures and now have `…Outcome` twins that carry a
  reason (`package-not-found`, `registry-unreachable`, `registry-http-<status>`,
  `metadata-not-json`, `package-name-not-requested`), and the audit writes it down. The last one
  is deliberately not called "invalid name": npm still serves legacy packages that predate the
  lowercase rule (`JSONStream` and `Base64` answer 200 today), so `isNpmPackageName` describes what
  this step will ask about, not what the registry has.

- The repository record no longer claims something it never checked. Its `packageManifest`
  component is `skipped` with reason `package-not-inspected` (was
  `no-package-declared-in-repository`). The old string read as a finding about the repository —
  "there is no package declared here" — when this build simply never looks: repository records are
  built from the census and the classification, and neither carries package data. Three
  repositories that do declare a `package.json` (firecrawl/firecrawl-mcp-server, upstash/context7,
  apify/apify-mcp-server) were recorded as declaring none. The reason now names what this build
  did, and nothing about the repository.

- The classification step now keeps the manifest path instead of only using it to pick a kind.
  `classifyPaths` already matched `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` and the
  rest — a repository with a server file `and` a manifest is what `server-like` means — and then
  discarded the path. It costs nothing to keep: the file tree was already fetched and parsed. With
  it, the reason a package was not read has three honest states rather than one:
  `manifest-found-not-inspected` (the tree lists a manifest; this step does not read it),
  `no-package-manifest-in-repository` (the tree was read and holds none — a checked absence), and
  `package-not-inspected` (a classification written before the field existed, which proves nothing
  either way). None of the three can make a record `clean`.

- `packages/collect/scripts/fetch-manifests.mjs` reads the manifest a repository declared and
  extracts the coordinates a package audit needs — registry, name, version — from `package.json`,
  `pyproject.toml`, `Cargo.toml`, `composer.json`, `pom.xml`, `*.csproj` and `go.mod`. It reads
  from `raw.githubusercontent.com`, which does not spend GitHub API quota, and it writes down the
  URL and a sha256 of the bytes it read, so anyone can fetch the same file and check the digest. It
  does not derive a name from the repository name and does not invent a version: a manifest without
  one yields `version: null`, which the policy layer already treats as missing evidence. A manifest
  it cannot read is reported as `unreadable` with the HTTP status, and one it can read but cannot
  parse is reported with the parse error — neither throws.

- `packages/collect/scripts/audit-packages.mjs` takes those coordinates and runs the same audit the
  registry path runs, so a repository record can carry measured evidence instead of a component that
  is skipped because nobody looked. The server object it builds carries no `transport`: inventing
  `stdio` would add a finding about a transport nobody checked. Hook scripts are fetched so their
  status is real rather than "missing because we did not ask". A registry this step cannot audit yet
  is reported as `unsupported-registry`, and a manifest with no package name as
  `no-package-name-in-manifest` — both are facts, and neither is a pass.

- `build-index.mjs --audit <package-audit.json>` joins that audit back into the index, so a
  repository record can carry the package coordinate and a measured `packageManifest` block
  instead of an empty `packages` array. Without the flag the records are exactly what they were.

  The invariant holds, and it is now spelled out. A repository record still can never be `clean`,
  because a third required component says why: `repositorySource`, skipped with reason
  `source-not-read`. The metadata block reads a repository's public metadata; the package block
  reads the package it publishes; **neither reads the repository itself**, which is what a reader
  would have to inspect to say anything about the server. Before this, "never clean" rested on the
  package half being skipped wholesale. It now rests on the gap that actually remains — and when
  that gap is closed, the component is removed rather than quietly reinterpreted.

- A second mapping: `agentgate framework --id eu-aia` covers the record-keeping obligations of
  Regulation (EU) 2024/1689 — Article 12 and Article 19. Eight items, and the count is published
  with them: 2 ours, 4 the customer's, 2 a third party's. **Almost nothing is ours, and that is the
  honest result rather than a modest one** — we do not run the customer's AI system and we do not
  produce its logs. What we can do is make the artefacts that do exist checkable
  (`content-digest`, `archive-integrity`) and count what could not be read
  (`coverage-accounting`, `scan-execution`).

  The entry that names Articles 12(3) and 12(4) says **未覆盖** and belongs to a third party,
  because this version of the mapping only read 12(1), 12(2), 19(1) and 19(2) — and it says which
  of them it read, in the `source` field, because a mapping that does not say what it read is a
  mapping nobody can check. The article text itself is not reproduced; only the paragraph numbers
  and our own wording, the same rule the CSA mapping follows.

- The four MCP tools declare what they return, and each description says when to use it. Glama
  scores tool definitions and publishes the rubric
  ([glama-ai/tool-definition-quality-score](https://github.com/glama-ai/tool-definition-quality-score));
  two of its six levers were unaddressed — no tool carried an `outputSchema`, and no description
  named the sibling to use for the other case.

  The schemas are written from the handler's own return values, not from intent.
  `protocol.mjs` puts the handler's `structured` object into `structuredContent`, so a schema here
  describes bytes a caller already receives. A test calls every tool and compares the declared
  schema against the sent value; breaking one field (`total: integer` → `string`) fails with
  `inventory_tools.summary.total: declared string, sent integer`.

## [0.4.0] - 2026-09-20

- The index can carry two kinds of record, and they are counted apart. `build-index.mjs --github
  <census> --classification <file>` adds a repository-level record for every repository the
  classification called a server and the registry does not already cover. Such a record can
  never be `clean`: its `packageManifest` component is `skipped`
  (`no-package-declared-in-repository`), so the state is incomplete by construction. A repository
  already represented by a registry row is not added again, and two records may not share one
  identity. `/v1/index/summary` and the evidence page report registry entries and repository
  records separately, because one coverage percentage over both would flatter the second kind.
- `agentgate refresh --repositories` runs the slower half of the chain: an incremental GitHub
  census (`--since`, unioned with the previous output) followed by an incremental classification
  that only fetches repositories whose `pushed_at` moved, with a path kept for every verdict.
  Without the flag, and without the artifacts on disk, the index is exactly what it was before.

- The formats are frozen and the promise is written down:
  [docs/spec/compatibility.md](docs/spec/compatibility.md) says what each version identifier means,
  what may change inside one, how a breaking change is announced, and which versions are supported.
  Every spec now declares `frozen` or `provisional`, and
  [docs/operations/upgrade.md](docs/operations/upgrade.md) carries a section for every released
  version, including the 0.1.1 change that made a stricter exit code look like nothing at all.
- [SECURITY.md](SECURITY.md) says how to report a vulnerability, what to expect, what is in scope,
  and which of our own properties a reporter can check. Private vulnerability reporting on GitHub
  is switched on.
- `test/governance.test.mjs` holds both promises to the code and to each other: the identifiers in
  the policy are the ones the modules export, and the upgrade guide and the CHANGELOG must name the
  same versions.

## [0.3.0] - 2026-09-18

- `agentgate pack` produces a deliverable a vendor can hand to the person reviewing them:
  `pack.json`, `pack.html`, `answers.aicaiq.md`, a per-file `manifest.txt` and a `manifest.sha256`
  seal. Every answer we claim points at evidence in the same directory, every item we could not
  measure is counted at the top of the page, and the command exits 2 rather than 0 when one of our
  answers is only partly measured. `agentgate pack --verify <dir>` recomputes every hash and the
  seal. Spec: [docs/spec/evidence-pack-v1.md](docs/spec/evidence-pack-v1.md), example generated
  from the live index: [docs/samples/evidence-pack-example](docs/samples/evidence-pack-example).
- The AI-CAIQ mapping now covers all 58 items of the four domains a reviewer asks a vendor about
  (STA 19, CCC 11, LOG 21, A&A 7) instead of 16 capability-level entries. 13 are ours, 41 are the
  customer's and 4 belong to an independent assessor; each one names the evidence classes it draws
  on, and a `we` entry with no evidence class fails the test suite. `framework` prints the same
  table, now with the evidence classes.
- Nine evidence classes decide what "measured" means for an answer: tool identity, exact version,
  content digest and scope, package metadata, scan execution, change history, archive integrity,
  coverage accounting and gateway decisions. The implemented classes and the ones the mapping may
  name are compared by a test, so a claim with nothing behind it cannot be added quietly.
- The pack reuses the existing scanner, inventory parser and archive; it adds no new measurement
  and never opens a socket. An explicitly named `--index` is a decision, not a preference: a missing
  file is an error rather than a silent fallback to the packaged sample.

## [0.2.5] - 2026-09-18

- The product moved to <https://xn--5kvo87g.com/> and the personal site that used to live there
  moved to <https://cicero.xn--5kvo87g.com/>. The old host `app.xn--5kvo87g.com` redirects pages to
  the apex and keeps serving `/v1`, `/health` and `/badge` directly. Every link in the README, the
  site pages, `server.json` and `security.txt` follows; no runtime behaviour changed.

## [0.2.4] - 2026-09-18

- `agentgate mcp` serves the index to any MCP client over stdio: four read-only tools
  (`lookup_server`, `inventory_tools`, `coverage_report`, `check_project`) that read the local
  index and never write, upload or run a scanned tool. An incomplete record is reported as
  incomplete, a missing record as missing rather than safe, and an explicitly named index that does
  not exist is not silently replaced by the packaged sample. Spec:
  [docs/spec/mcp-server-v1.md](docs/spec/mcp-server-v1.md).
- The coverage counting moved from `scripts/coverage-stats.mjs` into
  `packages/collect/src/coverage.mjs` so the script and the MCP server report the same numbers.
- `package.json` declares `mcpName: io.github.ciceroyang/agentgate` and `server.json` describes the
  same server for the official MCP Registry, which checks that the npm package and its metadata
  agree.

## [0.2.3] - 2026-09-18

- The publish workflow uses `actions/setup-node@v7` and removes the generated `.npmrc` before
  publishing. v4 exported a placeholder `NODE_AUTH_TOKEN`; npm 11 preferred that placeholder over the
  OIDC trusted-publishing exchange, and the registry answered `404 Not Found - PUT`. No runtime
  change. 0.2.1 and 0.2.2 were GitHub releases only — npm never received either — so this release
  also carries their changes.

## [0.2.2] - 2026-09-18

- The publish workflow clears `NODE_AUTH_TOKEN` for the publish step. `actions/setup-node` writes an
  `_authToken` line into `.npmrc` and exports a placeholder token when `registry-url` is set; npm 11
  preferred that placeholder over the OIDC trusted-publishing flow, and the registry answered
  `404 Not Found - PUT`. No runtime change. 0.2.1 was a GitHub release only — npm never received it,
  so this release also carries 0.2.1's changes.

## [0.2.1] - 2026-09-18

- The Action declares `name: Zhiliang agentgate`. GitHub Marketplace reserves the plain `agentgate`
  name — it collides with an existing account — so the Action could not be published under it.
  `uses: ciceroyang/agentgate@v0.2.1` is unchanged, and no behaviour changed.
- Every index record now carries a `scanExecution` block: which scanners were required, which
  completed, and whether their output was present, readable and self-consistent. A record with a
  failed or unmeasured required component can no longer be `clean`, whatever its findings say.
  Spec: [docs/spec/scan-execution-v1.md](docs/spec/scan-execution-v1.md). The field names inside
  `scanner_execution` follow the shape discussed in
  [modelcontextprotocol/registry#1404](https://github.com/modelcontextprotocol/registry/pull/1404)
  so the two records can be compared field by field.
- The record is surfaced where it is read: SARIF carries `invocations[].executionSuccessful` and one
  tool notification per failed component, `/v1/index/summary` reports coverage counts and reasons,
  `/v1/servers` rows carry the one-word state, and `required.scanners` lets a policy name the
  scanners it insists on.
- The index diff gained a `coverage changed` category: a record that stopped being fully measured
  (or started being) is reported on its own, because no version change explains it.
- `scripts/coverage-stats.mjs` turns an index into the coverage distribution — how many records are
  fully measured, what stopped the rest, and how many findings came out of the work that ran. It
  exits non-zero when a record claims a verdict its own coverage block cannot support, and it is the
  source of the numbers in
  [the coverage article](docs/articles/2026-09-how-much-of-the-mcp-ecosystem-is-auditable.md)
  ([中文](docs/articles/2026-09-how-much-of-the-mcp-ecosystem-is-auditable.zh-CN.md)).
- The inventory report now shows, per tool, which scanners actually ran: the coverage state, the
  required/completed/failed counts and one row per scanner. A record whose own coverage block says a
  required scanner did not finish can no longer reach `matched`, however complete the rest of its
  evidence looks, and a coverage block whose counts disagree with its own components is treated the
  same way. Spec: [docs/spec/inventory-v1.md](docs/spec/inventory-v1.md).

## [0.2.0] - 2026-09-17

- The README (English and Chinese) was rewritten in a plainer voice. No behaviour changed.
- `discover`, `audit`, `watch` and `framework` are in this release; see 0.1.2 below for what they do.
- Productionization P0–P6: /metrics and an optional access log, the health check with mail
  alerts, zero-dependency enforcement with our own SBOM, request limits, backup with a restore
  drill, the release check, and the public security and privacy pages.

  **Use 0.2.0 or later.** The provenance attestations of 0.1.0–0.1.2 name commits that are no
  longer on any branch or tag in this repository, so those versions cannot be checked the way
  this one can.

## [0.1.2] - 2026-09-17

- `agentgate discover`: reads the MCP configuration already on a machine (`.cursor/mcp.json`,
  `claude_desktop_config.json`, a repo's `.mcp.json`, Claude Code's per-project entries) and
  prints one line per server in the format `inventory --input` accepts. It never prints an env
  value, a header or an argument, and a config it cannot parse is listed and turns the exit code
  into 2 rather than being skipped.
- `agentgate audit`: the same scan per directory, one verdict for the set. Any incomplete
  directory makes the whole audit incomplete, and a directory that does not exist is an unmeasured
  repository rather than a skipped one.
- `agentgate watch`: an append-only, hash-chained archive of a tool list, with a diff against the
  previous capture and an optional push to a chat webhook. Nothing is sent anywhere without
  `--webhook`.
- `agentgate framework` and `inventory --framework aicaiq`: which AI-CAIQ v1.1.0 items we can
  supply evidence for, which are the customer's own, and which only an independent assessor can
  sign. It does not reproduce the official questionnaire text.
- Productionization (P0-P6 in docs/operations/productionization.md): observability and alerting,
  supply-chain self-checks with our own SBOM, service hardening, backup with a restore drill,
  release engineering, customer-facing compliance pages, and operations runbooks.

## [0.1.1] - 2026-09-17

- Published by CI with provenance and an SBOM; the tag is the release.
- `agentgate version` reads the version from package.json instead of keeping a second copy,
  which had already drifted once.
- Adoption checks made stricter: an artifact with an unmeasured part is `incomplete`, never
  `clean`.
- `discover`, `audit`, `watch` and the AI-CAIQ mapping (`framework`) arrive after this release.

## [0.1.0] - 2026-09-17

- First public release, published by hand because Trusted Publishing cannot bootstrap a package
  that does not exist yet.
- Inventory, evidence index, policy evaluation with SARIF, the gateway proxy, and the capture
  ledger with a verifiable hash chain.
