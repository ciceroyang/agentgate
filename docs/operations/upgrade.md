# Upgrading

*Every released version has a section here, whether or not it asks you to do something. A test
holds this file and the CHANGELOG to the same set of versions, because a release whose effect on
an existing installation nobody wrote down is a release that breaks someone quietly.*

How to read a section: **Affected** is who has to act, **Do** is what to run, **Check** is how to
see that it worked. “Nothing to do” is an answer, and it is written out rather than left blank.

The rules behind all of this — what a version identifier promises, what may change inside one, how
a breaking change is announced — are in [compatibility.md](../spec/compatibility.md).

## 0.6.0

The 0.5.0 package does not contain these fixes. This is a minor release under the compatibility policy because discovery
output and gate outcomes change. Do not overwrite or silently reuse an existing version.

- **Affected:** scripts consuming discovery text, required-evidence policy users, watch archive
  consumers, collector operators, Codex configuration users, evidence-pack reviewers and subpath
  site deployments. Do not start a new required-evidence admission gate on the affected 0.5.0
  package; an absent index could incorrectly pass there.
- **Do:** use `discover --format inventory` for a credential-free inventory JSON handoff, or accept
  registry-qualified text such as `npm:some-tool@1.2.3` and `pypi:some-tool@1.2.3`; legacy inventory
  text remains readable. Retain `discover --format json` separately for source and conflict review:
  the inventory input intentionally contains only tool identity, not config paths or diagnostics.
- **Do:** stop assuming that default discovery output is always line-based text: an alias-only
  entry makes it JSON so the alias cannot be misread as a package/version. The filename does not
  determine the format. Explicitly disabled Codex entries remain in full diagnostics but not in
  the inventory export. Unsupported MCP TOML forms exit incomplete, not empty-success.
- **Do:** pass an explicit, non-sample `--index` (Action input `index`) when the policy requires
  indexed evidence. The local npm package name and version must match the record. Absence is
  incomplete; an unreadable, malformed or sample index is an input error, not a fallback.
- **Do:** preserve existing watch archives and make a reviewed capture with the upgraded binary.
  An old projection has no identity/finding fingerprint, so this transition may show an
  added/removed baseline rather than a real package change. Subsequent captures compare the new
  projection. Do not rewrite old hashes or interpret this migration as a new vulnerability.
- **Do:** after approving collection, refresh repository metadata/classification, rerun
  `fetch-manifests.mjs` and `audit-packages.mjs`, then rebuild the index with that audit. Legacy
  cache entries without identity and observation metadata are not reused by these scripts.
  `agentgate refresh` alone does not run the manifest/audit stages; it can still consume an audit
  already on disk. Rebuilding an index is not a new observation and does not migrate old evidence.
- **Do:** treat an empty archive or an empty/non-decision call log as unmeasured. Pack verification
  proves internal file/hash consistency only, not authentic observation time, log completeness or
  protection against rebuilding the entire pack. Keep an independently trusted copy when needed.
- **Do:** use `build-site.mjs --base-path /agentgate` for the project-site deployment. Supply
  `--diff-index-sha256` only when the diff genuinely belongs to those exact index bytes; an
  unbound diff is omitted. Refresh failure now stops Pages deployment instead of publishing a sample.
- **Check:** run `npm test`, `npm run test:package`, the acceptance scripts and `scripts/verify.sh`; inspect sample labels,
  observation times, required-evidence failures and the migration capture before customer use.
  Local success does not validate the deployed service, a customer's environment or customer adoption.
- **After publication:** use the exact version, compare the registry integrity with the accepted
  CI tarball, then rerun `scripts/check-delivery.mjs` against a fresh extraction of the public
  tarball before promoting `latest`. Keep the prior archive and deployment snapshot for rollback;
  never turn a newly incomplete result back into a pass just to match the old result.

## 0.5.0

- **Affected:** anyone reading `execution.byReason` out of `/v1/index/summary`, anyone who runs
  `refresh` on a schedule, and anyone whose code branches on a finding rule name from the package
  audit.
- **What changed:** the package audit now actually reaches the published index. `refresh` never
  passed `--audit` to `build-index`, so every scheduled rebuild dropped the audit and left ~6,200
  audited packages described as "a package is declared here" — no error, no log line, the artifact on
  disk the whole time. With it joined, `packageManifest` appears on repository records and the
  coverage summary names what could not be measured instead of folding it into one word.
  Three vocabularies became finer: a package whose metadata is absent now says whether the registry
  has no such package or this run could not reach it; a hook script now says whether the package does
  not ship it, a CDN did not answer, or this step did not ask; and a file the package does not ship
  became its own finding, `install-hook-script-missing-from-package`, rather than an unknown.
  The four MCP tools declare `outputSchema`, and each description names when to use it and which
  sibling to use instead.
- **Do:** nothing is required to upgrade, but two things are worth a look if you consume the data.
  If you were treating every `metadata-unavailable` as one state, read the `reason` beside it —
  `package-not-found` and `package-name-not-requested` are different facts. If you match on
  `install-hook-script-unavailable`, note that the "package does not ship the file" case moved out
  of it into `install-hook-script-missing-from-package`.
- **Check:** `curl -s http://127.0.0.1:8080/v1/index/summary | jq -r '.execution.byReason | keys[]'`
  lists `package-not-found` on an index built by this version; a 0.4.0 index has no such key.
  `curl -s http://127.0.0.1:8080/v1/servers/github.com/mksglu/context-mode | jq '.record.evidence.packageManifest.findings[].rule'`
  prints the install-hook findings for a package that has them.

## 0.4.0

- **Affected:** anyone who reads a coverage percentage out of `/v1/index/summary` or the evidence
  page, or who runs `refresh`.
- **What changed:** the index can carry two kinds of record — registry entries and repository
  records — and they are counted **apart** (`sources.registry` / `sources.repositories`), because
  one percentage over both would flatter the second kind. A repository record can never be `clean`:
  its `packageManifest` component is skipped, so its state is incomplete by construction.
  `refresh --repositories` runs the slower half of the chain — an incremental GitHub census, then a
  classification that only re-fetches repositories whose `pushed_at` moved. The formats and the
  version identifiers are frozen, and [compatibility.md](../spec/compatibility.md) now says what
  each one promises.
- **Do:** nothing, unless you were dividing the record count by something — read `sources` instead
  of the top-level `count`. Without `--repositories` and without the two artifacts on disk, the
  index is exactly what it was in 0.3.0.
- **Check:** `curl -s http://127.0.0.1:8080/v1/index/summary | jq .sources` prints both counts; on
  a 0.3.0 installation the key is absent.

## 0.3.0

- **Affected:** anyone parsing `framework --format json`, or embedding the questionnaire mapping.
- **What changed:** the AI-CAIQ table grew from 16 capability-level entries to all 58 items of the
  four domains a reviewer asks a vendor about (STA, CCC, LOG, A&A), and every entry gained an
  `evidence` array naming the evidence classes it draws on. The new `pack` command builds the
  deliverable from that table; nothing existing changed behaviour.
- **Do:** nothing. If you parse the JSON, read `id`, `owner` and `evidence` per entry instead of
  assuming how many there are.
- **Check:** `node bin/agentgate.mjs framework --format json | jq ".entries | length"` prints `58`.

## 0.2.5

- **Affected:** nobody.
- **What changed:** links and metadata only. The product moved to the apex domain and the personal
  site moved to `cicero.`; no runtime behaviour changed.
- **Do:** nothing.

## 0.2.4

- **Affected:** anyone who called `scripts/coverage-stats.mjs` directly.
- **What changed:** the coverage counting moved into `packages/collect/src/coverage.mjs`, and the new
  read-only `mcp` command serves four tools over stdio from the same index.
- **Do:** nothing. The script still runs and now shares its code with the MCP server, so the two
  cannot report different numbers.

## 0.2.3

- **Affected:** nobody using the tool; it is a publish-pipeline fix.
- **What changed:** the publish workflow uses `actions/setup-node@v7` and removes the generated
  `.npmrc`, which is why `0.2.0` published and `0.2.1`/`0.2.2` did not reach npm at all.
- **Do:** nothing. This release carries the changes of 0.2.1 and 0.2.2.

## 0.2.2

- **Affected:** anyone who pinned this version from npm. It never arrived.
- **What changed:** the publish attempt failed with `404 Not Found - PUT` because npm preferred a
  placeholder token written by the workflow over the OIDC exchange.
- **Do:** use `0.2.3` or later; `npm i @zhiliangtech/agentgate@0.2.2` answers `E404`.

## 0.2.1

- **Affected:** anyone whose pipeline read index records, and anyone who pinned this version from
  npm.
- **What changed:** two things. Every index record now carries a `scanExecution` block — which
  scanners were required, which completed, whether their output was present, readable and
  self-consistent — and a record whose own coverage block says a required scanner did not finish can
  no longer be `clean`, whatever its findings say. Separately, this version was a GitHub release
  only; npm never received it.
- **Do:** rebuild the index (`node bin/agentgate.mjs refresh`) so records carry the block. If you
  diff an old index against a new one, expect verdicts to move from `clean` to `incomplete`: that
  movement is the change, not a regression. Records written before the block existed are unaffected
  and are handled the way they were before.
- **Check:** `curl -s localhost:8080/v1/index/summary | jq .coverage` reports the coverage counts and
  the reasons behind them.

## 0.2.0

- **Affected:** everyone on 0.1.x.
- **What changed:** this is the first release whose provenance can be checked. The attestations of
  `0.1.0`–`0.1.2` name commits that are no longer on any branch or tag in this repository, so those
  versions cannot be verified the way this one can. This release also adds `/metrics`, the health
  check with mail alerts, request limits, backup with a restore drill, the release check, and the
  zero-dependency enforcement with our own SBOM.
- **Do:** move to `0.2.0` or later and stop pinning `0.1.x`.
- **Check:** `npm view @zhiliangtech/agentgate@0.2.0 dist.attestations.provenance.predicateType`
  prints `https://slsa.dev/provenance/v1`.

## 0.1.2

- **Affected:** nobody upgrading; this is where `discover`, `audit`, `watch` and `framework` first
  appear.
- **What changed:** four new commands plus the productionization work (observability, supply-chain
  self-checks, service hardening, backup, release engineering, customer-facing security pages).
- **Do:** nothing.

## 0.1.1

*This is the worked example of a breaking change, kept here because it is the kind that does not
look like one.*

- **Affected:** any CI pipeline that ran `check` and read the exit code as pass or fail.
- **What changed:** the adoption checks became stricter. An artefact with an unmeasured part is
  `incomplete`, and the exit code is 2 — it used to be 0 in some of those cases. Nothing in the
  output moved; only the code a pipeline acts on.
- **Do:** treat the exit codes as three outcomes rather than two: `0` clean, `1` a finding at the
  threshold, `2` something could not be checked. Fail the pipeline on 2 as well. `--fail-on`
  deliberately does not affect 2, and there is no flag to turn an unmeasured artefact into a pass;
  a gate that ignores 2 is a gate that passes what nobody measured.
- **Check:** give the policy an artefact whose manifest is unmeasured, run
  `node bin/agentgate.mjs check --policy policy.json --root .`, and confirm `echo $?` prints `2`.

## 0.1.0

- **Affected:** anyone still pinned to it.
- **What changed:** the bootstrap release, published by hand, with no provenance attestation.
- **Do:** move to a supported version. The window is defined in
  [compatibility.md](../spec/compatibility.md); `0.1.x` is deprecated on npm.
