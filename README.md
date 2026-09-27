**English** · [中文](README.zh-CN.md)

# agentgate

A control plane for the tools agents run. It inventories what is in use, records the evidence
behind every claim, states what a company refuses, and enforces that decision in CI and at
runtime.

The whole project follows one rule:

> `clean` is emitted only when every check ran. Anything that could not be measured is
> `unmeasured`, and an artefact with an unmeasured part is `incomplete` — never `clean`.

That rule is there because the usual failure of a security scanner is a green build for work
nobody did. Here a check that crashes makes the result incomplete, so it cannot happen quietly.

## The four parts

| part | what it does | package |
| --- | --- | --- |
| **inventory** | enumerate the registry, resolve packages, fetch repositories | `packages/collect` |
| **evidence** | join it into one record per server, with the bytes behind every claim | `packages/collect` |
| **policy** | scan configs, hooks, manifests and source for what a company would refuse | `packages/guard` |
| **verification** | check a claim against something outside the claim | `packages/verify` |

## Running it

Server setup is in [docs/operations/deployment-runbook.md](docs/operations/deployment-runbook.md).
The first deployment, on 2026-09-16, is written up in
[docs/verification.md](docs/verification.md) together with what was checked and what still is not.

[docs/capabilities.md](docs/capabilities.md) lists what this project can and cannot claim, one line
each, every line carrying a command you can run. It exists because a consultant once wrote our
capabilities down for us and included four we do not have.

## Try it without installing

The service runs at <https://xn--5kvo87g.com/>: landing page, pricing, the evidence index
(rebuilt daily) and the API on the same host.

<https://ciceroyang.github.io/agentgate/> is the landing page on GitHub Pages. The index is a
single browsable page at <https://ciceroyang.github.io/agentgate/evidence.html>, rebuilt daily
from the live registry — records are embedded, filtering happens locally, and there is nothing to
sign up for. [Pricing](https://ciceroyang.github.io/agentgate/pricing.html) and a
[ten-minute walkthrough](https://ciceroyang.github.io/agentgate/try.html).

## Quickstart

**Upgrading to 0.6.0:** read [the upgrade guide](docs/operations/upgrade.md#060) before replacing
an existing admission gate or watch installation. The 0.5.0 package can incorrectly pass a
required-evidence gate when evidence is absent; do not use it for a new gate. Confirm the version
you installed, and see the [release record](https://github.com/ciceroyang/agentgate/releases/tag/v0.6.0)
for public-package verification. A source checkout and the hosted service may run different versions.

Node 20 or newer, no dependencies. A clone already carries a sample index, so the service
answers immediately; `refresh` replaces it with a current one.

```sh
node bin/agentgate.mjs serve
# agentgate serving http://127.0.0.1:8080

curl -s localhost:8080/health
curl -s localhost:8080/v1/index/summary
curl -s localhost:8080/v1/servers/<name>
curl -s localhost:8080/badge/<name>.svg
```

The package is on npm as `@zhiliangtech/agentgate`. Push a `v*` tag and CI publishes it with
provenance; [publish-checklist.md](docs/operations/publish-checklist.md) has the setup and the
record of what was verified.

```sh
npx --yes --ignore-scripts @zhiliangtech/agentgate@0.6.0 check --root .
npx --yes --ignore-scripts @zhiliangtech/agentgate@0.6.0 serve
```

An unversioned `npx` command follows the `latest` dist-tag, not this checkout. Pin the accepted
version; editing a local version number does not change the public package.

With no policy file, `check` uses a built-in default that refuses nothing extra, and `serve`
answers from the snapshot the package shipped with. `refresh` writes to `./data` next to you,
never into the installed package.

Docker works too, and runs the same command:

```sh
docker compose up                            # the service on :8080
docker compose --profile collect run --rm refresh   # rebuild data/index.json and seed the first snapshot
```

## Tool inventory

Run `node bin/agentgate.mjs serve` and open `/inventory.html` at the address it prints. Paste a
list of tool names or pick a text/JSON file, resolve ambiguous matches, fill in the version you
actually use, and download a standalone HTML report. The comparison happens in browser memory
against the embedded index snapshot: the list is not uploaded or stored, your machine is not
scanned, and no tool is executed. When a record carries a coverage block, the report also lists
which scanners ran and which did not, and why; a record whose own coverage block says a required
scanner did not finish will not be shown as matched, however complete the rest of its evidence looks.

The same thing without a browser:

```sh
node bin/agentgate.mjs inventory --input examples/inventory/tools.json --out my-tools.html
node bin/agentgate.mjs inventory --input tools.json --index data/index.json --format json
```

An input is one name per line, a JSON array, or `{ "tools": [...] }`. Each object may carry
`name`, `server`, `package`, `registry` and `version` — nothing else. Full client
configurations and credentials are rejected on purpose. The
[inventory guide](docs/spec/inventory-v1.md) has the details.

Unmatched, ambiguous, missing-version, mismatched-version and incomplete-evidence items stay in
the report. A version match is not proof of what is installed. The committed sample is
historical and cannot produce a confirmed match; neither can old evidence without an exact
content binding. Even a confirmed match is not a safety certification and not a new scan. Look
at the scopes, the findings, the snapshot date and the gaps before you rely on it.

Exit code 0 means a report was produced, not that every tool passed. Malformed input or
unreadable data exits 2, and `--out` will not overwrite an existing file. When you want CI to
refuse something, use `check`, not `inventory`.

### Getting the list in the first place

Nobody has this list by hand. `discover` reads the MCP configuration files already on the
machine and produces input that `inventory --input` accepts. It prints package coordinates as
lines when all exported identities are known; if any entry is alias-only, it uses JSON so an
alias such as `tool@1.2.3` cannot be mistaken for a verified package and version:

```sh
node bin/agentgate.mjs discover --out tools.txt          # home directory + current directory
node bin/agentgate.mjs discover --roots ~/code/a,~/code/b --format json
```

It never prints an `env` value, a header or an argument, and a remote address is cut down to its
host, because paths and query strings carry tokens. It reads Codex's `.codex/config.toml` MCP
tables without starting the configured servers. Explicitly disabled entries remain visible in
`--format json` but are omitted from text and inventory exports. Unsupported MCP TOML shapes,
malformed files and unreadable files are listed with a reason and make the command exit 2.
Package names and versions are taken only from recognizable declared runner arguments; a custom
command or remote host is **not** treated as a verified package or runtime version.

### Several repositories

```sh
node bin/agentgate.mjs audit --roots ~/code/a,~/code/b,~/code/c --index data/index.json
```

One scan per directory, one verdict for the set. Any incomplete directory makes the audit
incomplete, and a directory that does not exist counts as unmeasured rather than skipped.

### Changes since last time

```sh
node bin/agentgate.mjs watch --input tools.txt --index data/index.json --archive ./archive
node bin/agentgate.mjs watch --verify --archive ./archive
node bin/agentgate.mjs watch --input tools.txt --index data/index.json --archive ./archive \
  --webhook https://example.invalid/hook --webhook-format wecom
```

Every run appends one line to a chained archive (`prev` is the previous line's hash) and stores
what it saw under `snapshots/<sha256>.json`. `--verify` recomputes the chain and every retained
snapshot, and exits 1 if anything does not match. Nothing is sent anywhere unless `--webhook`
names an address, and the archive is written before the push, so a chat service being down cannot
lose a capture.

### Questionnaire mapping

```sh
node bin/agentgate.mjs framework                       # who answers which AI-CAIQ item
node bin/agentgate.mjs inventory --input tools.json --framework aicaiq --out report.html
```

For each AI-CAIQ item the mapping says what we can provide, where our coverage stops, and whether
the answer is ours, the customer's, or an independent assessor's. It describes evidence. It is
not a compliance conclusion and it does not reproduce the official text. All 58 items of the four
domains a reviewer asks a vendor about are classified: 13 answers are ours, 41 are the customer's
and 4 need an independent assessor.

### Evidence pack

The mapping says what we can provide. `pack` produces the thing itself: one directory a vendor
hands to the person reviewing them, where every answer we claim points at evidence in the same
directory and everything we could not measure is counted at the top.

```sh
node bin/agentgate.mjs pack --input tools.json --archive ./agentgate-archive --out agentgate-pack
node bin/agentgate.mjs pack --verify agentgate-pack     # recompute every hash and the seal
```

It writes `pack.json` (machine readable), `pack.html` (for the reviewer), `answers.aicaiq.md` (all
58 items, each classified), `manifest.txt` (one sha256 per file) and `manifest.sha256` (the seal on
the manifest). An answer whose evidence is missing reads `unmeasured` and the command exits 2, not
0. Example built from the live index:
[docs/samples/evidence-pack-example](docs/samples/evidence-pack-example) — verifiable with
`pack --verify`. Contract: [docs/spec/evidence-pack-v1.md](docs/spec/evidence-pack-v1.md).

## MCP server

Anything that speaks MCP can ask the index directly. Add this to `claude_desktop_config.json`, a
repo's `.mcp.json`, or whatever your client reads:

```json
{
  "mcpServers": {
    "agentgate": { "command": "npx", "args": ["--yes", "@zhiliangtech/agentgate@next", "mcp"] }
  }
}
```

Four read-only tools: `lookup_server` (one record, with its coverage block), `inventory_tools`
(match the tools you actually use), `coverage_report` (how much of the index was measured) and
`check_project` (scan a local directory). It reads the local index, never writes, never uploads,
and never runs a scanned tool. An incomplete record is reported as incomplete, and a record that
the index does not have is reported as missing rather than safe. Details:
[docs/spec/mcp-server-v1.md](docs/spec/mcp-server-v1.md).

## Policy

A policy states what a company refuses. It is data rather than code, and it has a spec:
[docs/spec/policy-v1.md](docs/spec/policy-v1.md).

```json
{
  "version": "agentgate.policy/v1",
  "threshold": "high",
  "required": { "pinnedPackages": true, "measuredEvidence": ["packageManifest"] },
  "forbidden": { "rules": ["AG-INSTALL-001"], "servers": ["internal/*"] }
}
```

```sh
node bin/agentgate.mjs check --policy agentgate.policy.json --root . --index data/index.json
```

The policy above requires indexed evidence. Supply a real index matching the local npm package's
exact name and version: missing evidence exits 2; an explicit missing, malformed or sample index
exits 3. A local source scan does not substitute for the required package evidence.

With no policy file and no `--policy`, the check still runs. It reports what the checks found and
says it used the built-in default, which refuses nothing extra; inventing obligations on your
behalf would make the result mean less, not more. A policy you name explicitly and that cannot
be read is an error, because that is a typo.

The same evaluation can go to a person instead of a terminal:

```sh
node bin/agentgate.mjs check --policy agentgate.policy.json --root . --index data/index.json --format html --out report.html
```

One static, printable file with no script in it. Anything that could not be measured gets its own
section above the findings: a report that buries what it did not check reads as more complete
than it is. This file is what the free checkup delivers.

There are three outcomes, and `incomplete` outranks `findings`. If a check failed to run, or an
evidence block the policy requires is `unmeasured`, the exit code is `2` however clean the
findings look. No threshold turns a partial answer into a pass.

| exit | meaning |
| --- | --- |
| 0 | clean |
| 1 | findings |
| 2 | incomplete |

## Enforcement

A pull request that adds something the policy refuses will not merge, and the reason is posted on
the pull request rather than left in a log nobody opens.

```yaml
- uses: ciceroyang/agentgate@main
  with:
    policy: agentgate.policy.json
    index: data/index.json
```

See [examples/github-actions/policy.yml](examples/github-actions/policy.yml). The action runs the
check, writes SARIF for code scanning, comments the report on the pull request, and exits with
the check's own code — so an incomplete scan still fails the build at 2.

## Runtime

The same policy can apply to what has already shipped, if you put a gateway in front of the
server instead of pointing your client at it:

```sh
node bin/agentgate.mjs proxy --policy agentgate.policy.json --log calls.jsonl -- \
  npx -y @modelcontextprotocol/server-filesystem /data
```

A call the policy refuses is answered locally with a reason and never reaches the server. A
forbidden tool is removed from the advertised list, so a client cannot ask for it at all. Every
decision, allowed or refused, is appended to the log.

## History

The index is kept, so two builds can be compared. The interesting column is the last one:
changes that a release would have explained and did not.

```sh
node bin/agentgate.mjs diff --from previous-index.json --to data/index.json
```

```
  added:           0
  removed:         0
  verdict changed: 1
  package changed: 0
  silent (no version move, different evidence): 1
```

A new finding on an unchanged version usually means a package was replaced without a release, a
repository was edited in place, or the scan has started seeing something. That record cannot be
back-filled. It only exists if someone was looking at the time.

## The pipelines behind the index

```sh
node packages/collect/mcp-audit.mjs --max 6000 --out data/census.json
node packages/collect/scripts/guard-scan.mjs --census data/census.json --out data/guard-scan.json
node packages/collect/scripts/build-index.mjs --census data/census.json --guard data/guard-scan.json --out data/index.json
node scripts/coverage-stats.mjs --index data/index.json   # how much of it was actually measured
```

And the scanner on a local project:

```sh
node packages/guard/bin/agent-guard.mjs . --fail-on high
node packages/collect/bin/agent-add.mjs --index data/index.json <server-name>
```

## Writing

- [We indexed 11,605 MCP records and could audit 258 of them](docs/articles/2026-09-how-much-of-the-mcp-ecosystem-is-auditable.md) ([中文](docs/articles/2026-09-how-much-of-the-mcp-ecosystem-is-auditable.zh-CN.md)) — how many of the collected servers were actually measured, and what stopped the rest. The numbers are the 2026-09-19 build the piece was written against; the index is rebuilt several times a day and moves.
- [The loudest rule was wrong nine times out of nine](docs/articles/2026-09-the-loudest-rule-was-wrong.md)
- [Clean is a claim about work that was done](docs/articles/2026-09-clean-is-a-claim.md)
- [A reason that reads as a finding](docs/articles/2026-09-a-reason-that-reads-as-a-finding.md) — five coverage gaps whose text described the subject when it should have described the scanner. Four of them are mine.

## Test

```sh
npm test                              # the whole suite; it prints how many ran
node scripts/bench.mjs 50000 200      # lookups must stay under 10 ms p50
node scripts/measure-verify.mjs       # claim extraction, against a small labelled set
node packages/guard/scripts/regression.mjs   # benign must stay silent, positives must fire
```

## Layout

```
packages/guard     the scanner: engine, nine checks, CLI, corpus, GitHub Action
packages/collect   census, package and repository scanning, the evidence index
packages/policy    policy evaluation and human-readable reports
packages/gateway   runtime policy enforcement for MCP servers over stdio
packages/history   index snapshots and change comparisons
packages/service   the read-only evidence API
packages/verify    cross-model claim checking
docs/              architecture and product notes
```

## Verification

The tests are written by the same people who wrote the code.
[docs/verification.md](docs/verification.md) records the checks that are not: a real MCP server
through the gateway, and the list of what is still unverified.

```sh
node scripts/verify-real-server.mjs
```

To see whether the index's `high` and `critical` findings still match recorded human reviews, run
`node scripts/review-criticals.mjs`. A review has to bind the finding and its evidence to an
exact package version and to complete scanned-content provenance, including the SHA-256 digest
and the scope. A missing or changed binding needs another human review, and legacy approvals are
not upgraded automatically. `--accept` records a review that has already happened and refuses
incomplete provenance; it neither performs the review nor certifies third-party code.

## Operations

- [docs/operations/deployment-runbook.md](docs/operations/deployment-runbook.md) — aliyun plus the 智量.com domain, including the ICP filing caveat.
- [docs/operations/plan-b-no-icp.md](docs/operations/plan-b-no-icp.md) — what to do when a mainland server has no ICP filing.
- [deploy/](deploy/) — the Caddyfile and a systemd unit, ready to copy to a server.
- [docs/operations/pilot-package.md](docs/operations/pilot-package.md) — the pilot one-pager: deliverables, timeline, what we ask for and what we do not.
- [site/index.html](site/index.html) and [site/pricing.html](site/pricing.html) — the landing and pricing pages, self-contained, no external assets.
- [scripts/onboard-server.sh](scripts/onboard-server.sh) — the deployment steps as a script that prints what it would do and only acts with `--apply`.
- [scripts/smoke.mjs](scripts/smoke.mjs) — the post-deployment check: reachable, index present and recent, records real rather than the sample.

## Status

This is an early open-source core. It covers collection, an evidence index, scanning, policy
checks in CI, a runtime gateway for MCP servers over stdio, historical diffs and a read-only
service. Deployment scripts and a runbook are in the tree, and the first deployment with its
checks is written up in [docs/verification.md](docs/verification.md). That write-up says nothing
about the current health of the hosted service. The container path is not asserted but built: CI runs `docker compose up --build` and then a health check against the running container.

What the version identifiers promise, and which versions are supported, is written down in
[docs/spec/compatibility.md](docs/spec/compatibility.md); [SECURITY.md](SECURITY.md) says how to report
a vulnerability and what to expect. Neither is a substitute for gate 3 and gate 4 above — the
enterprise surface is still missing and nobody outside this repository depends on it yet.

The enterprise features described in the pricing proposal — SSO/SAML, RBAC, multi-tenancy and
signed audit export — are not implemented. The Team and Enterprise prices are unvalidated
hypotheses; the free pilot is how we test whether anyone wants this. See the
[pilot scope](docs/operations/pilot-package.md) and the [licence](docs/product/licensing.md).

One invariant is in the test suite: a crashed check can never produce `clean`. Run `npm test`
for the current numbers; this page does not repeat a test count.

## Licence

AGPL-3.0-only. If you want to offer a modified agentgate as a closed service without publishing
your changes — the case the AGPL does not permit — a commercial licence is available. See
[docs/product/licensing.md](docs/product/licensing.md).
