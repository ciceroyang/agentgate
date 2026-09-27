[English](README.md) · **中文**

# agentgate

agent 工具层的控制面。它清点在用的工具，记录每条结论背后的证据，写明一家公司拒绝什么，并在 CI 和运行时把那个决定执行下去。

整个项目只有一条规则：

> 只有每一个检查都跑完，才会给出 `clean`。任何测不到的东西都是 `unmeasured`；一件作品只要有一块没测到，它就是 `incomplete`，永远不会是 `clean`。

这条规则存在，是因为安全扫描器最常见的失败是**给没做过的活发绿灯**。在这里，一个崩掉的检查会把结论变成 incomplete，所以它不可能悄悄发生。

## 四个部分

| 部分 | 做什么 | 代码 |
| --- | --- | --- |
| **inventory** | 枚举注册表、解析包、抓取仓库 | `packages/collect` |
| **evidence** | 合成每台 server 一条记录，每条断言背后都有原始字节 | `packages/collect` |
| **policy** | 扫配置、钩子、清单与源码，找出一家公司会拒绝的东西 | `packages/guard` |
| **verification** | 用断言之外的东西去检验断言 | `packages/verify` |

## 运行它

部署步骤在 [docs/operations/deployment-runbook.md](docs/operations/deployment-runbook.md)。2026-09-16 的第一次部署、当时查了什么、还有什么没查，都写在 [docs/verification.md](docs/verification.md)。

## 不装也能看

服务在 <https://xn--5kvo87g.com/>：落地页、价格、证据索引（每天重建）和 API 都在同一个域名下。

<https://ciceroyang.github.io/agentgate/> 是 GitHub Pages 上的落地页。索引是一页可以浏览的 <https://ciceroyang.github.io/agentgate/evidence.html>，每天从实时注册表重建——记录内嵌在页面里，筛选在本地跑，不需要注册。价格页在 [pricing.html](https://ciceroyang.github.io/agentgate/pricing.html)，[try.html](https://ciceroyang.github.io/agentgate/try.html) 是十分钟走一遍。

## 快速开始

**升级到 0.6.0 前，请先阅读[升级说明](docs/operations/upgrade.md#060)。** 0.5.0 在必需证据缺失时可能误放行，不要再用于新的必需证据准入流程。请核对实际安装版本，并在[发布记录](https://github.com/ciceroyang/agentgate/releases/tag/v0.6.0)查看公开安装包复验；源码工作区与托管服务可能运行不同版本。

Node 20 或更新，零依赖。clone 下来自带一份样本索引，服务立刻能答；`refresh` 会把它换成当天的。

```sh
node bin/agentgate.mjs serve
# agentgate serving http://127.0.0.1:8080

curl -s localhost:8080/health
curl -s localhost:8080/v1/index/summary
curl -s localhost:8080/v1/servers/<name>
curl -s localhost:8080/badge/<name>.svg
```

包发布在 npm 上，名字是 `@zhiliangtech/agentgate`。推一个 `v*` tag，CI 就发一个带 provenance 的版本；那套配置和验证过的事实记在 [publish-checklist.md](docs/operations/publish-checklist.md)。

```sh
npx --yes --ignore-scripts @zhiliangtech/agentgate@0.6.0 check --root .
npx --yes --ignore-scripts @zhiliangtech/agentgate@0.6.0 serve
```

不带版本的 `npx` 跟随 `latest`，不会跟随当前工作区；实际交付应钉住验收过的精确版本，本地改了版本号不代表公开包已经更新。

没有策略文件时，`check` 用内置默认策略（不额外拒绝任何东西），`serve` 用它发布时带的那份快照作答。`refresh` 只写你身边的 `./data`，不会写进装好的包目录。

也可以走 docker，跑的是同一条命令：

```sh
docker compose up                            # 服务在 :8080
docker compose --profile collect run --rm refresh   # 重建 data/index.json 并写入第一份快照
```

## 工具清单

先 `node bin/agentgate.mjs serve`，打开它打印出来的地址上的 `/inventory.html`。把工具名清单粘进去，或选一个文本/JSON 文件，处理需要确认的匹配，填上你实际在用的版本，然后下载一份独立的 HTML 报告。对照发生在浏览器内存里、对着内嵌的索引快照：**清单不上传、不保存，不扫描你的机器，也不执行任何工具。**记录里带有扫描覆盖块时，报告还会列出**哪些扫描器真的跑完、哪些没跑成、为什么**；一条记录如果自己的覆盖块写着必需扫描器没跑完，哪怕其余证据看起来完整，也不会被显示成已匹配。

不用浏览器也行：

```sh
node bin/agentgate.mjs inventory --input examples/inventory/tools.json --out my-tools.html
node bin/agentgate.mjs inventory --input tools.json --index data/index.json --format json
```

输入可以是一行一个名字、一个 JSON 数组，或 `{ "tools": [...] }`。每个对象只能有 `name`、`server`、`package`、`registry`、`version` 五个字段，别的都不接受；完整的客户端配置和凭据是**故意拒绝**的。细节见[清单指南](docs/spec/inventory-v1.md)。

匹配不上、需要确认、缺精确版本、版本不一致、证据不完整——这些条目都会留在报告里。**版本对上了不等于机器上装的就是它。** 仓库里那份样本是历史数据，给不出确认过的匹配；没有精确内容绑定的旧证据也一样。就算匹配成功，那也不是安全认证，不是一次新的扫描。用之前先看检查范围、发现、快照日期和缺口。

退出码 0 表示**报告生成了**，不表示所有工具都通过；输入格式错误或数据读不了退出 2，`--out` 也不会覆盖已有文件。要让 CI 拦住东西，用 `check`，不要用 `inventory`。

### 清单从哪来

没有人手上有这份清单。`discover` 读机器上已经存在的 MCP 配置文件，输出可直接交给 `inventory --input`。若导出项都有可识别包坐标，就一项一行；只要有仅知别名的条目，就改用 JSON，避免把 `tool@1.2.3` 这样的别名误认成已核实的包和版本：

```sh
node bin/agentgate.mjs discover --out tools.txt          # 主目录 + 当前目录
node bin/agentgate.mjs discover --roots ~/code/a,~/code/b --format json
```

它**永远不打印** `env` 的值、请求头或启动参数，远程地址只留主机名——路径和查询串里常有 token。它只读解析 Codex 的 `.codex/config.toml` 中的 MCP 配置，不启动服务；明确禁用的条目保留在 `--format json` 供核对，但不进入文本与 inventory 导出。存在但读不了、格式错误或 MCP TOML 形状暂不支持的文件会连原因一起列出，并把退出码置成 2。包名和版本只来自能识别的启动器参数；自定义命令或远程主机**不等于**已核实的包身份或运行时版本。

### 一次看多个仓库

```sh
node bin/agentgate.mjs audit --roots ~/code/a,~/code/b,~/code/c --index data/index.json
```

每个目录跑一次同样的扫描，整体给一个结论。任何一个目录是 incomplete，整个 audit 就是 incomplete；目录不存在算**没测到**，不是被跳过。

### 相比上次变了什么

```sh
node bin/agentgate.mjs watch --input tools.txt --index data/index.json --archive ./archive
node bin/agentgate.mjs watch --verify --archive ./archive
node bin/agentgate.mjs watch --input tools.txt --index data/index.json --archive ./archive \
  --webhook https://example.invalid/hook --webhook-format wecom
```

每次运行往一个链式归档里追加一行（`prev` 是上一行的哈希），并把看到的内容存进 `snapshots/<sha256>.json`。`--verify` 重算整条链与每份保留的快照，对不上就以 1 退出。**除非显式给 `--webhook`，什么都不会发出去**；归档先写、推送后做，所以聊天服务挂了也不会丢一次采集。

### 问卷对照

```sh
node bin/agentgate.mjs framework                       # 哪些 AI-CAIQ 条目由谁交账
node bin/agentgate.mjs inventory --input tools.json --framework aicaiq --out report.html
```

每条 AI-CAIQ 条目下面写着：我们能提供什么、覆盖到哪里为止、这条最终由**我们**、**你们**还是**独立评估方**交账。它描述的是证据，不是合规结论，也不转载官方原文。评审人真正会问供应商的四个域共 **58 条全部有归类**：13 条我们出证据、41 条你们自证、4 条要独立评估方。

### 证据包

对照表说的是「我们能给什么」，`pack` 把它变成能交出去的东西：一个目录，交给客户的评审人；我们声称的每条答案都指向同一目录里的证据，没测到的部分写在最上面。

```sh
node bin/agentgate.mjs pack --input tools.json --archive ./agentgate-archive --out agentgate-pack
node bin/agentgate.mjs pack --verify agentgate-pack     # 重算每个文件的 sha256 与封条
```

产出 `pack.json`（机器可读）、`pack.html`（给评审人看）、`answers.aicaiq.md`（58 条逐条归类）、`manifest.txt`（逐文件一个 sha256）和 `manifest.sha256`（manifest 的封条）。证据没测到的答案写 `unmeasured`，命令以 2 退出而不是 0。样例（用线上索引生成）：[docs/samples/evidence-pack-example](docs/samples/evidence-pack-example)，可直接用 `pack --verify` 复核。契约：[docs/spec/evidence-pack-v1.md](docs/spec/evidence-pack-v1.md)。

## MCP server

任何会说 MCP 的客户端都能直接问这份索引。把下面这段加到 `claude_desktop_config.json`、仓库里的 `.mcp.json`，或你的客户端读的那个文件：

```json
{
  "mcpServers": {
    "agentgate": { "command": "npx", "args": ["--yes", "@zhiliangtech/agentgate@next", "mcp"] }
  }
}
```

四个只读工具：`lookup_server`（一条记录，连同它的覆盖块）、`inventory_tools`（比对你实际在用的工具）、`coverage_report`（这份索引被测过多少）、`check_project`（扫一个本地目录）。它只读本地索引，不写、不上传、不执行被扫的工具；没测完的记录就报没测完，索引里没有的就报没有——不报"安全"。细节见 [docs/spec/mcp-server-v1.md](docs/spec/mcp-server-v1.md)。

## 策略

策略说的是这家公司拒绝什么。它是数据不是代码，而且有规范：[docs/spec/policy-v1.md](docs/spec/policy-v1.md)。

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

上述策略要求索引证据，必须提供与本地 npm 包名和精确版本对应的真实索引：没有对应证据退出 2；显式索引不存在、格式错误或是历史样本退出 3。本地源码扫描不能代替要求的包证据。

没有策略文件、也没给 `--policy` 时，check 照样跑：它报告检查发现了什么，并说明自己用的是内置默认策略（不额外拒绝任何东西）——**替用户发明义务只会让结果更不值钱**。但明确指定了却读不了的策略文件仍然是错误，那说明打错了字。

同一份评估也可以交给一个人，而不是交给终端：

```sh
node bin/agentgate.mjs check --policy agentgate.policy.json --root . --index data/index.json --format html --out report.html
```

一个静态、能打印、无脚本的文件。**测不到的东西会单独成节、排在发现前面**：一份把"没查的部分"埋起来的报告，读起来比它实际更完整。这个文件就是免费体检的交付物。

三种结局，而 `incomplete` 优先于 `findings`。只要有一个检查没跑成，或者策略要求的证据块是 `unmeasured`，退出码就是 **2**，不管发现看起来多干净。**没有任何阈值能把局部的答案变成通过。**

| 退出码 | 含义 |
| --- | --- |
| 0 | clean |
| 1 | findings |
| 2 | incomplete |

## CI 拦截

一个 PR 如果加了策略拒绝的东西，就合不进去，而且**理由写在 PR 上**，不是留在一个没人打开的日志里。

```yaml
- uses: ciceroyang/agentgate@main
  with:
    policy: agentgate.policy.json
```

见 [examples/github-actions/policy.yml](examples/github-actions/policy.yml)。这个 action 跑检查、为 code scanning 写 SARIF、把报告评论到 PR 上，然后用检查自己的退出码退出——所以没测完的扫描仍然会以 2 让构建失败。

## 运行时

同一套策略也可以管已经发布出去的东西：不把客户端直接指向 server，而是在前面放一个网关。

```sh
node bin/agentgate.mjs proxy --policy agentgate.policy.json --log calls.jsonl -- \
  npx -y @modelcontextprotocol/server-filesystem /data
```

策略拒绝的调用在本地被回答、附上原因，**永远到不了 server**。被禁止的工具会从对外宣告的列表里摘掉，客户端连问都问不到。每一个决定，允许的、拒绝的，都追加进日志。

## 变更历史

索引是留存的，所以两次构建可以对比。最有意思的是最后一列：**本该由一次发版解释、却没有解释的变化。**

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

版本没动、却发现变了，通常意味着包被换过但没发版、仓库被就地改过、或者扫描器开始看到新东西。**这条记录没人能事后补**，只有当时有人在看，它才存在。

## 索引背后的流水线

```sh
node packages/collect/mcp-audit.mjs --max 6000 --out data/census.json
node packages/collect/scripts/guard-scan.mjs --census data/census.json --out data/guard-scan.json
node packages/collect/scripts/build-index.mjs --census data/census.json --guard data/guard-scan.json --out data/index.json
node scripts/coverage-stats.mjs --index data/index.json   # 其中真正被测过的有多少
```

在本地项目上跑扫描器：

```sh
node packages/guard/bin/agent-guard.mjs . --fail-on high
node packages/collect/bin/agent-add.mjs --index data/index.json <server-name>
```

## 文章

- [2,057 个 MCP server,审计跑完的是 264 个](docs/articles/2026-09-how-much-of-the-mcp-ecosystem-is-auditable.zh-CN.md)([English](docs/articles/2026-09-how-much-of-the-mcp-ecosystem-is-auditable.md))——采到的 server 里真正被测过的有多少,其余的卡在哪。
- [The loudest rule was wrong nine times out of nine](docs/articles/2026-09-the-loudest-rule-was-wrong.md)
- [Clean is a claim about work that was done](docs/articles/2026-09-clean-is-a-claim.md)

## 测试

```sh
npm test                              # 全套；会打印跑了多少项
node scripts/bench.mjs 50000 200      # 查询必须保持在 10 ms p50 以内
node scripts/measure-verify.mjs       # 断言抽取，对着一小份带标注的集合
node packages/guard/scripts/regression.mjs   # 良性的必须沉默，阳性必须命中
```

## 目录

```
packages/guard     扫描器：引擎、九项检查、CLI、语料、GitHub Action
packages/collect   普查、包与仓库扫描、证据索引
packages/policy    策略评估与给人看的报告
packages/gateway   针对 stdio MCP server 的运行时策略执行
packages/history   索引快照与变更比较
packages/service   只读证据 API
packages/verify    跨模型断言核对
docs/              架构与产品笔记
```

## 验证

测试和代码是同一方写的。[docs/verification.md](docs/verification.md) 记录的是那些**不是这里的人写的东西**上的核对：一台真实的 MCP server 通过网关，以及还有什么没验的清单。

```sh
node scripts/verify-real-server.mjs
```

想检查索引里的 `high` 与 `critical` 发现是否仍然对得上人工复核记录，跑 `node scripts/review-criticals.mjs`。每次复核必须把发现和它的证据绑定到一个**精确的包版本**和完整的扫描内容来源，包括 SHA-256 摘要与范围。绑定缺失或变化就要重新人工复核，旧的批准记录不会自动升级。`--accept` 记录一次已经发生过的复核，并且拒绝不完整的来源；它不代替你做复核，也不认证第三方代码。

## 运维

- [docs/operations/deployment-runbook.md](docs/operations/deployment-runbook.md) — 阿里云加 智量.com 域名，含 ICP 备案的坑。
- [docs/operations/plan-b-no-icp.md](docs/operations/plan-b-no-icp.md) — 大陆机器没有备案时怎么办。
- [deploy/](deploy/) — Caddyfile 和 systemd 单元，复制到服务器就能用。
- [docs/operations/pilot-package.md](docs/operations/pilot-package.md) — 试点一页纸：交付物、时间线、我们要什么、不要什么。
- [site/index.html](site/index.html) 与 [site/pricing.html](site/pricing.html) — 落地页与价格页，自带资源，不加载外部文件。
- [scripts/onboard-server.sh](scripts/onboard-server.sh) — 把部署步骤写成脚本：先打印要做什么，只有加 `--apply` 才动手。
- [scripts/smoke.mjs](scripts/smoke.mjs) — 部署后的自检：通不通、索引在不在且新不新、记录是真的还是样本。

## 状态

这是一个早期的开源内核：采集、证据索引、扫描、CI 里的策略检查、针对 stdio MCP server 的运行时网关、历史对比，以及一个只读服务。部署脚本和 runbook 都在树里，第一次部署和当时的核对写在 [docs/verification.md](docs/verification.md)。**那份记录不说明线上服务当前是否健康**，Docker 镜像构建也仍然没验过。

版本标识承诺什么、哪些版本还在支持窗口内，写在 [docs/spec/compatibility.md](docs/spec/compatibility.md)；怎么报漏洞、会得到什么回应，写在 [SECURITY.md](SECURITY.md)。这两份都不是企业能力的替代品——该有的还没有，也还没有第二个团队在依赖它。

价格方案里的企业能力——SSO/SAML、RBAC、多租户、签名审计导出——**尚未实现**。Team 与 Enterprise 的价格是**未经验证的假设**；免费试点就是用来验证有没有人要的。见[试点范围](docs/operations/pilot-package.md)与[许可说明](docs/product/licensing.md)。

测试套件里有一条不变量：**崩掉的检查永远不可能产出 `clean`。** 当前数字跑 `npm test` 看，这一页不重复测试数量。

## 许可

AGPL-3.0-only。AGPL 不允许的那种用法——把修改过的 agentgate 作为闭源服务提供而不公开你的修改——可以谈商业许可。见 [docs/product/licensing.md](docs/product/licensing.md)。
