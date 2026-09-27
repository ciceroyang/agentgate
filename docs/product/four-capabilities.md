# 四个能力的设计（先定接口与边界，再写代码）

*2026-09-17。对着国内客户的平台工程师做的四件事。**每一条都先写清「输出什么、没测到什么、什么情况退出码是 2」，再实现。***

## 0. 不许破的四条

1. **未测到不等于没有。** 任何「读不到、解析不了、没覆盖」都要出现在输出里，并且把整体标成不完整（退出码 2），不能静默跳过。
2. **不读凭据、不出凭据。** 只读 JSON 结构里的服务器定义；不读 env/headers 的值；不输出 args 原文；远程地址只留主机名（路径和查询串里常有 token）。
3. **不联网。** 这四个能力都不发请求（推送是第 3 个能力里显式的 --webhook 才发）。
4. **不替客户认证。** 第 4 个能力的每条输出都标注「我们出证据 / 客户自证 / 第三方」，绝不出现「已合规」。

## 1. agentgate discover —— 本机/仓库的配置发现

**为什么**：现在 value chain 的起点是「客户给我一份清单」，而工程师手上没有这份清单。这一步把手动整理变成一条命令。

**接口**

    agentgate discover [--home <目录>] [--roots a,b] [--format text|json] [--out <文件>]

- 默认扫当前目录（项目级）+ 用户主目录（机器级）；两个范围可以用参数覆盖，测试就靠这个。
- 目录**不存在不算错误**（大多数路径本来就不存在）；**存在但读不了/解析不了算不完整**。
- 输出中每条服务器：本地名、来源文件、范围（machine/project）、工具（cursor/claude-desktop/...）、传输方式、以及能从启动命令里解析出的 npm 包名与版本。
- --format text 的输出**必须能被 agentgate inventory --input 直接吃**（用 parseInventory 做往返测试）。

**边界**：.codex/config.toml（TOML）这一版**不解析**，但会作为 unparsed 列出来并把退出码置 2——比假装没看见它安全。
**退出码**：0 = 找到的都读了；2 = 有找到但读不了/解析不了的来源。

## 2. 组织级聚合扫描 —— 一次扫多个 repo

**为什么**：真实客户是几十个 repo，现在的 check --root 一次只看一个。
**接口**：agentgate audit --roots a,b,c [--format text|json|html] [--out <文件>]
- 复用 packages/guard/src/engine.mjs 的 runScan，每个 repo 一次，绝不重写检查逻辑。
- 聚合规则：**任何一个 repo 的 verdict 是 incomplete，整体就是 incomplete**；没有 incomplete 且有 findings，整体 findings；全 clean 才 clean。退出码沿用 0/1/2。
- 报告里每个 repo 一行（verdict + 命中数），再给整体结论和「哪些 repo 完全没扫成」。

## 3. 客户清单的归档与变更推送

**为什么**：报告是静态的，四周试点结束后唯一还活着的东西是「变了什么」。
**接口**：agentgate watch --input tools.txt [--archive <目录>] [--webhook <URL>] [--index <索引>]
- 每次运行：把这份清单的**输入内容**与**匹配结果**写进 archive（只追加的 jsonl，每行带上一行哈希 + 内容寻址的快照），与上一次比较，输出中文差异摘要（新增/移除/版本变化/证据变化）。
- **不传 --webhook 就只写本地，不发任何请求。** 传了才 POST 摘要（企业微信/飞书/Slack 都是 JSON POST；失败要报错并保留归档，不能因为推送失败丢数据）。
- 复用 packages/history/src/ledger.mjs 的哈希与内容寻址，不另造一套。

## 4. AICM / AI-CAIQ 问卷映射

**为什么**：工程师的真实痛点是「问卷第几条要什么证据」。**这份对照表已经发出来了**（0.3.0 起）：`agentgate framework --format json` 输出 58 条（STA 19 / CCC 11 / LOG 21 / A&A 7），不再是 markdown 草稿 —— 这一节当初写的是"要写成什么样"。
**接口**：agentgate inventory --framework aicaiq（或 agentgate framework），报告里每条问卷条目后面挂我们的证据行。
- 数据是**我们自己的**对照表：条目编号（STA-09.1 这类）、我们的一句话说明、我们能给什么、边界、以及归属（我们/客户/第三方）。
- **不收录 CSA 官方问卷原文**（许可 + 我们不想把别人的文本当成自己的），也不输出「已满足」这种词：每条只能写「我们能给的证据」和「这块不是我们」。
- 覆盖范围以 saas-industry-pack.md 第 2 节那 15 条为起点，逐条变成数据 + 测试（编号唯一、归属合法、边界非空）。

## 测试要求（每个能力都要有的负例）

- 读不了 / 解析不了 → 出现在输出里 + 退出码 2；
- 输入里有像凭据的值 → 序列化后的输出里**一个字符都不能出现**；
- 边界输入：空文件、空对象、数组形状、重复名称、超长路径；
- 与其它组件的契约：discover 的 text 输出必须能被 inventory 解析；audit 的聚合规则用三个 repo 的合成 fixture 各验一次（clean/findings/incomplete）。

## 不做的

- 不做 Windows 注册表、不做 EDR 集成、不做云端上报；TOML 只报不解析；
- 不做「自动修复」；
- 不改现有的 check / inventory 行为（四个都是新增命令）。
## 实现状态（2026-09-17）

| 能力 | 命令 | 模块 | 测试 |
| --- | --- | --- | --- |
| 1 | `discover` | `packages/guard/src/discover.mjs`、`known-configs.mjs` | `packages/guard/test/discover.test.mjs`（13）、`test/discover-cli.test.mjs`（5） |
| 2 | `audit` | `packages/policy/src/audit.mjs`（聚合），扫描复用从 `check()` 抽出的 `runCheck()` | `packages/policy/test/audit.test.mjs`（6）、`test/audit-cli.test.mjs`（6） |
| 3 | `watch`、`watch --verify` | `packages/watch/src/watch.mjs`（链复用 history 的 `hashOfLine`） | `packages/watch/test/watch.test.mjs`（13）、`test/watch-cli.test.mjs`（6） |
| 4 | `framework`、`inventory --framework aicaiq` | `packages/policy/src/framework.mjs` | `packages/policy/test/framework.test.mjs`（8）、`test/framework-cli.test.mjs`（5） |

两处是被测试抓出来才改对的（记在这里，因为它们是这套不变量最容易破的地方）：

- `discover` 一开始只打印「这份清单不完整」，忘了把退出码置成 2——**说了不完整却仍然返回成功**；
- `audit` 的聚合最初只统计已知 verdict，一个不认识的 verdict 会被算成 clean——**未知又变成了干净**。

明确没做的（免得以后以为做了）：TOML（`.codex/config.toml`）只报不解析；`watch` 的归档没有自动清理与留存策略；`framework` 目前只有 AI-CAIQ v1.1.0 一张表，且是**能力级**映射，不是逐项自动对应（不做逐项是因为那需要推理，推理就会变成编）。

## 2026-09-25 的后续修订（纳入 0.6.0）

上文是 2026-09-17 的设计与当时实现状态，不代表 0.6.0 的行为。`discover` 对 Codex 的 `mcp_servers` TOML 表做有界解析：报告只保留服务器别名、命令的可识别包坐标、远程主机与明确的启用状态，不保留或输出环境变量、请求头与原始参数。明确禁用的条目留在完整 JSON 报告以便核对，但不进入默认清单或 inventory 导出；无法解析的 MCP TOML 形状仍标不完整并退出 2。默认清单遇到只知别名的条目时使用 JSON，避免别名被下游误认成包名与版本。自定义命令和远程主机不能据此声称已获得精确包身份或运行时版本。实际安装包版本应单独核对，旧版不包含这些修复。
