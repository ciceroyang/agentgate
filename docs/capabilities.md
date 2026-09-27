# 这个项目能讲什么

*这一页只有一条规则：**每一行都跟着一条能跑的命令**。跑不出那条命令的东西，不该出现在这一页 ——
也不该出现在我们说给别人听的任何地方。*

*建立它的直接原因：一次外部咨询把我们没做的东西（Merkle 证明、行为序列检测、4D 信任评分、
LangGraph 集成）当成已有能力写进了分析。那些名字在整个仓库里一次都没出现过。**一份把我们夸大的
分析，比一份说我们不够好的分析危险得多** —— 因为它会在下一轮变成我们的对外承诺。*

## 一、有的

| 能力 | 代码在哪 | 跑这条命令 | **这条不证明什么** |
| --- | --- | --- | --- |
| 有哪些命令 | `bin/agentgate.mjs` | `node bin/agentgate.mjs --help` | 帮助不会启动服务或采集；含 `refresh --help` 的无副作用回归 |
| 版本 | `package.json` | `node bin/agentgate.mjs version` → `agentgate 0.6.0` | 只说明当前代码的版本；公开安装包和线上部署须分别核对 |
| 索引有两个来源，分开计数 | `packages/collect/scripts/build-index.mjs` | `curl -s https://xn--5kvo87g.com/v1/index/summary` 看 `sources.registry` / `sources.repositories` | 数字只是"我们索引里有多少条"，不是"生态里有多少" |
| 每条记录带扫描执行块 | `packages/collect/src/execution.mjs` | 同上，看 `execution.byReason` | 它说"哪些检查跑了"，不说"这个 server 安全" |
| 仓库记录永远不会是 clean，理由写在组件里 | `packages/collect/src/repository-records.mjs` | `node --test packages/collect/test/repository-records.test.mjs` | 它不读仓库源码 —— 组件里写明 `source-not-read` |
| 证据包可自校验 | `packages/pack` | `node bin/agentgate.mjs pack --verify docs/samples/evidence-pack-example` → 验通过、退出码 0 | 只检查包内文件与摘要的一致性，不证明内容真实，也不能防止整包连同摘要一起重写 |
| 链式账本可校验 | `packages/history/src/ledger.mjs` | `node bin/agentgate.mjs history --verify` → `chain verified` | 本地没有捕获时它验的是空链，并且会把 0 条说出来 |
| 三值判据，故意没有分数 | `packages/verify/src/check.mjs` | `node --test packages/verify/test/*.test.mjs` | 不是可信度评分。`clean` 只在每个检查都跑过时才发出 |
| 执行前拦截（单次调用） | `packages/gateway/src/decide.mjs` + `agentgate proxy` | `node --test packages/gateway/test/*.test.mjs` | **单次调用的模式判定**；没有身份、委托、目的对齐、跨请求行为序列 |
| 策略层：证据缺失清单，且不完整会传染 | `packages/policy/src/evaluate.mjs` | `node --test packages/policy/test/*.test.mjs` | 它列"缺什么证据"，不做合规判定 |
| 静态清单扫描 | `packages/guard` | `node --test packages/guard/test/*.test.mjs` | 只看 `.mcp.json` 一类清单，**不运行代码、不读源码** |
| 变更检测：版本没变但证据变了 | `packages/history/src/diff.mjs` | `node --test packages/history/test/*.test.mjs` | 要有两次可比快照；没有时它明说没有 |
| 只读 MCP server | `packages/mcp` | `node --test packages/mcp/test/*.test.mjs` | 只读 |
| 别人的要求清单 → 我们的证据映射 | `packages/policy/src/framework.mjs` | `node bin/agentgate.mjs framework --id eu-aia` | 它说明**我们能给什么证据**，不是合规结论；未覆盖的条目会明写「未覆盖」 |
| 一个包装了没有、装的时候会在安装期跑什么 | `packages/collect/scripts/audit-packages.mjs` | `curl -s https://xn--5kvo87g.com/v1/servers/github.com/mksglu/context-mode` → `packageManifest` 里有 `install-time-execution` 与 `install-hook-script-critical` | **只读脚本文本，从不运行**。`critical` 描述的是**能力**（安装期执行、能触网、能起进程），不是恶意：逐条读过的 critical 里，多数是下载二进制、装 Python 依赖、注册宿主机钩子这类**包的用途本身要求**的行为 |
| 测不了的，写明是**哪一种**测不了 | `packages/collect/mcp-audit.mjs` | `curl -s https://xn--5kvo87g.com/v1/index/summary` → `execution.byReason` 里 `package-not-found` 与 `package-name-not-requested` 是分开的两条 | 「注册表里没有这个包」是关于**包**的事实，「这次没够着注册表」是关于**这次运行**的事实。它们不合并，但也不代表我们已经测过别的 |

## 二、没有的（外面提到过，但我们没做）

这一张比上面那张重要。查证方式：

```sh
grep -rIl --exclude-dir=node_modules --exclude-dir=.git \
  -e Merkle -e BULK_READ_THEN_EXFIL -e SENSITIVITY_RAMP -e DIRECTORY_SWEEP -e LangGraph . \
  | grep -v docs/capabilities.md | wc -l
# → 0    （排除这一页自己：这些名字只在这一页里出现，这句 grep 就是证明）
```

| 被提到的 | 状态 |
| --- | --- |
| Merkle 证明 | **没有**。账本是哈希链（`packages/history/src/ledger.mjs`），不是 Merkle 树 |
| Ed25519 签名 | **没有** |
| 行为序列 / 杀伤链检测 | **没有**。`BULK_READ_THEN_EXFIL`、`SENSITIVITY_RAMP`、`DIRECTORY_SWEEP` 各 0 命中 |
| 4D 信任评分（身份 25% / 委托 25% / 目的 30% / 行为 20%） | **没有**。0 命中 |
| LangGraph 集成 | **没有**。0 命中 |
| 身份 / 委托 / 目的对齐 | **没有** |
| SSO / SAML / RBAC / 多租户 / 企业留存 / 签名审计导出 / SIEM 对接 | **没有**。README 已写明 |
| Team ¥29,800 / Enterprise ¥158,000 定价 | **未经客户验证的价格假设**（README 原话） |
| **第一个外部用户** | **还没有** —— 这一条比上面所有加起来都重要 |

## 三、怎么用这一页

引用 Agentgate 的能力之前，先跑那一行的命令。跑不通，就不要讲。

这不是自谦。这个项目对外的全部说服力都建立在同一句话上：**没测完，不报 clean**。
一页把自己没做的东西说成做过的能力清单，正好是这句话的反面。
