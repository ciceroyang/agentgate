# npm 发布清单

> 给"没做过 npm 发布"的人看。每一步写清点哪里、填什么、看到什么算成功。
> **2026-09-18：修好并跑通。** 账号与作用域见第一节；`0.1.0` 本机手动发（bootstrap），之后由 CI 用 OIDC 发布（带 provenance）。2026-09-18 修掉了两个发布失败原因（setup-node 的占位 token、仓库重建后可信发布者绑定失效），`0.2.3` 已发到 `next`；`latest` 仍是 `0.2.0`。

## 0.6.0 发布流程

以下是当前发布要求；后文带日期的记录是历史，不是当前状态。
0.6.0 将必需证据误放行、清单身份丢失、变化漏报和 Codex 配置解析的修复一起交付。
因为输出格式和准入结果改变，按[兼容规则](../spec/compatibility.md)升次版本；
不要重新发布 0.5.0，也不要把本地验收说成公开包已经修复。

本地准备（不发布、不推送）：

```sh
npm test
node scripts/release-check.mjs --tag v0.6.0 --online
npm run test:package
```

最后一条会建立独立临时目录、打包、解包，再对交付的代码运行合成场景验收；输出的
`release.json` 记录安装包摘要，`acceptance.json` 记录每项结果。也可使用
`node scripts/pack-release.mjs --out-dir /absolute/new-directory` 留在指定新目录，已有目录会被拒绝。
它不下载依赖、不运行客户配置，也不执行 npm/GitHub 写入。

发布时必须按顺序完成：

1. 审阅改动和[迁移说明](upgrade.md#060)，确认发布授权后提交全部预期文件；更新候选状态与发布日期，重新验收，不带脏工作区打 tag。
2. `package.json`、`server.json`（含内层 npm 版本）和 `lhm.plugin.json` 一致；`release-check` 已自动检查，遗漏任何一处会失败。
3. 推送经过审阅的确切 tag 后，CI 跑完整测试、构建并验收安装包；发布前再次核对摘要，然后向 `next` 发布这个文件，而不是重新打包目录。
4. 保存 CI 的 `verified-package` 与 `sbom` 产物。验收回执只防止流程中的意外替换，不是数字签名；发布来源以 npm provenance 为准。
5. 等待 registry 实际可读，用公开版本元数据核对版本、provenance 和 `dist.integrity` 与 CI 回执一致；下载该公开 tarball 到新目录、解包，再执行下面的同一验收脚本。发布日志成功不等于这一步完成，传播延迟时不要重复发布。

   ```sh
   node scripts/check-delivery.mjs /absolute/public-package/package public-0.6.0 /absolute/new-public-acceptance.json
   ```

6. 公开包复验、部署演示与升级检查通过后，才考虑提升 `latest`；GitHub release 附上 SBOM、安装包摘要和公开复验结果。MCP registry、LobeHub 的更新是单独的外部写入，不能由本地同步版本推断已经更新。

这条流程使用 npm 支持的[直接发布 tarball](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。
本地通过只说明候选安装包在约定场景下可用，不代表客户覆盖率、客户验收或企业部署完成。

## 零、先理解三个词（30 秒）

- **npm**：JavaScript 的包仓库。别人跑 `npx @zhiliangtech/agentgate` 时，东西就是从这里下载的。
- **作用域（scope）**：包名前 `@` 后面那一段。`@zhiliangtech/agentgate` 里的 `zhiliangtech` 就是作用域。
- **关键**：作用域必须是**你自己的 npm 用户名**，或者**你拥有的组织**。
  - 我们的账号是 `zhiliangtech`，所以包名是 `@zhiliangtech/agentgate`——这是**用户作用域，不需要建组织**。
  - **为什么不叫 `@zhiliang`**：registry 上 `zhiliang` 这个作用域属于**另一个账号**。2026-09-17 实测：用我们的账号往
    `@zhiliang/agentgate` 发布，registry 返回 **404 Not Found on PUT**——npm 对"不属于你的作用域"就返回 404，
    不是 403。所以那个名字拿不到；也不值得为它去找到对方。

## 一、账号（已完成，2026-09-17）

| 项 | 值 |
| --- | --- |
| 用户名 | `zhiliangtech` |
| 邮箱 | `zhiliangtech@163.com`（已验证） |
| 两步验证 | **已开，模式 `auth-and-writes`**（发布必须；只开 authorization 发布仍会被拒） |

本机登录（网站登录与命令行登录是两件事，命令行要单独拿 token）：

```sh
npm login --auth-type=legacy    # 网页被 Cloudflare 挡住时的备用路径；会问用户名/密码/OTP
npm whoami                      # 应打印 zhiliangtech
```

## 二、发布第一个版本（已完成 2026-09-17；bootstrap，需要 OTP）

```sh
cd <agentgate 仓库目录>
npm publish --access public --tag next --no-provenance --otp=<6位动态码>
```

- `--tag next` 是故意的：先发到 `next`，等自托管演示验过了再提升到 `latest`。
- `--no-provenance`：本机没有 OIDC 提供方，而 `package.json` 里写了 `publishConfig.provenance: true`。
  **只有 0.1.0 这一个版本没有 provenance**，之后都走 CI，都带。
- 如果 npm 打印 `https://www.npmjs.com/auth/cli/...` 让你在浏览器确认，就打开确认（终端别关）。
- 成功标志：出现 `+ @zhiliangtech/agentgate@0.1.0`。

## 三、验证它真的发出去了

```sh
npm view @zhiliangtech/agentgate@next version
npx --yes @zhiliangtech/agentgate@next version
npx --yes @zhiliangtech/agentgate@next check --root .
```

最后一条应该直接出结果，不需要 policy 文件（用内置默认策略，并会打印它用的是默认）。

## 四、绑定 Trusted Publishing（已完成）

npm 网站 → 你的包 `@zhiliangtech/agentgate` → **Settings** → **Trusted Publisher** → GitHub Actions：

| 字段 | 填什么 |
| --- | --- |
| Organization or user | `ciceroyang` |
| Repository | `agentgate` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

绑定之后，仓库里不需要存任何 npm token。

已核对：`npm trust list @zhiliangtech/agentgate` 显示 `github / publish.yml / ciceroyang/agentgate / 权限 publish, stage publish`。

**2026-09-18：这条绑定是重新建的。** 仓库在 2026-09-17 被删除后重建，GitHub 的仓库 ID 变了，npm 上保留的旧绑定因此对不上；OIDC 交换返回
`{"message":"OIDC token exchange error - package not found"}`——包明明在，这是 npm 用来表示"信任不匹配"的含糊报错。删掉旧连接、按上表重新添加（并勾上允许 `npm publish`）后恢复正常。
**仓库改名、转移或删后重建，都要重建这条绑定。**

`publish.yml` 里有两个必须保持的点：

- **用 `actions/setup-node@v7` 或更新。** v4 只要设了 `registry-url` 就会导出一个占位 `NODE_AUTH_TOKEN`（`XXXXX-XXXXX-XXXXX-XXXXX`），npm 11 优先用这个假 token 而不是 OIDC，registry 回一个误导性的 `404 Not Found - PUT`。
- **发布前删掉 setup-node 生成的 `.npmrc`**（`rm -f "$NPM_CONFIG_USERCONFIG"`）。里面那行 `_authToken=${NODE_AUTH_TOKEN}` 即使指向空值，也会让 npm 认为"已有凭证"而不走 OIDC，表现为 `ENEEDAUTH`。

## 五、历史发版步骤（当前要求以上方 0.6.0 发布流程为准）

```sh
# 1) 改 package.json 的 version；2) 把 CHANGELOG 的 Unreleased 归到这个版本
git tag v0.2.4 && git push origin main --tags
gh release create v0.2.4 --title "0.2.4" --notes-file /tmp/notes.md   # 可选；不建 release 也能发 npm，只是 SBOM 不会挂到 release 上
```

工作流会跑完整测试 → 拒绝 tag 与 version 不一致 → 用 OIDC 发布（带 provenance），不需要任何动态码或密钥。

registry 可能先回一句 `Your package is being processed and may take a few minutes to become available.`，大约 30 秒后 dist-tags 才可见——**看到这句就是发布成功，不是错误**。

已跑通：`v0.1.1`（2026-09-17）、`v0.2.3`（2026-09-18）、**`v0.5.0`（2026-09-21，run 35621901451，SLSA provenance，SBOM 挂在 release 上）**。
`v0.2.1`、`v0.2.2` 只有 GitHub release，没有上 npm。

**0.5.0 这次的实况：workflow 里那一步「Attach the SBOM to the release when there is one」打的是
`no GitHub release for v0.5.0; the SBOM is on this workflow run` —— 因为 release 是在 publish
之后才建的。** 所以顺序上有两种做法，任选其一：(a) 先 push tag 让 CI 发版，再从 workflow 产物里
把 SBOM 下载下来挂到新建的 release 上（0.5.0 和 0.4.0 都是这么补的）；(b) 先建 release 再推 tag，
workflow 就会自动挂。**别让它只留一个会过期的 workflow artifact** —— 信里那条「你可以自己核」会核不动。

## 六、提升到 latest 的历史记录

**0.5.0 已于 2026-09-21 提升到 `latest`**（发布由 CI 用 OIDC 完成，带 SLSA provenance；提升由人执行）：

```sh
npm dist-tag add @zhiliangtech/agentgate@0.5.0 latest
```

现状（2026-09-22 00:0x 核对，registry 直连，不读本机缓存）：`{"latest":"0.5.0","next":"0.5.0"}`。
验证：`npm_config_cache` 指到空目录再跑 `npx --yes @zhiliangtech/agentgate@latest version` → `agentgate 0.5.0`。

**第一次跑 `dist-tag add` 会先撞 E401**（本机根本没登录），按第五节那段先做 `npm login --auth-type=web`；
然后**写操作本身还要一次 WebAuthn**（账号是 `auth-and-writes`，登录 ≠ 授权写）。
0.5.0 这次两步都照这一页走通了。

**2026-09-21 补一条实测：registry 的传播比这一页原先写的一分钟慢得多。**
publish 那一步打印 `+ @zhiliangtech/agentgate@0.5.0` 并说 "being processed" 之后，
**直连 `dist-tags` 在 1 分钟、3 分钟时都还是旧的，版本 URL 还是 404；到约 5 分钟才变**。
所以「发布成功」的判据是日志里的 `+ @zhiliangtech/agentgate@x.y.z` 与
`Provenance statement published to transparency log`，**不是立刻能查到**。
在等到之前不要重发——重发会撞 "cannot publish over the previously published versions"。

**2026-09-20 这次的三处实况（和上一次不同，值得记）：**

- 本机 npm **根本没登录**，所以第一步不是动态码而是 E401：`Unable to authenticate, your authentication token seems to be invalid`。先 `npm login --auth-type=web`，它给一个 URL —— **这一次是免码的**，因为浏览器本来就登录着 npmjs.com，打开就显示「身份验证成功」。此后 `npm whoami` 才回 `zhiliangtech`。
- 写操作那一步的验证 **不是 6 位动态码，是 WebAuthn 安全密钥**：给的 URL 是 `/auth/cli/<uuid>`，打开后会跳到 `/escalate/webauthn?next=...`，页面上是「双因素身份验证 → 安全密钥」，要人在浏览器里碰一下硬件密钥或 Touch ID。**所以这一步 agent 自己过不去，必须把页面开给人看。** `expect` 那句仍然有用：它负责在 pty 里把 URL 打出来。
- 提完之后 **本机 `npx @latest` 还是打印旧版本**（这次是 0.2.4），这不是失败，就是 packument 缓存。以 registry 直连的 `/-/package/<name>/dist-tags` 为准，或者换一个空的 `npm_config_cache`。

**这一步有两个坑，2026-09-18 都踩到了：**

- **它也要一次浏览器 2FA**，不是登录一次就够。账号是 `auth-and-writes`：`npm login --auth-type=web` 只解决"已登录"，而 `dist-tag add` 是写操作，会再打印一个 `https://www.npmjs.com/auth/cli/<uuid>` 让你去验证。非交互环境下 npm 会立刻退出（URL 在日志里是 `***`），所以在 pty 里跑才能等到你验证完：

  ```sh
  expect -c 'set timeout 600; spawn npm dist-tag add @zhiliangtech/agentgate@0.2.4 latest; expect { -re {https://www\.npmjs\.com/auth/cli/[^ ]+} { puts $expect_out(0,string) } }; interact'
  ```

  然后把打印出来的 URL 在**已登录 npm 的浏览器**里打开、过 security key（或 password）。注意 URL 有有效期，隔太久再点会过期，要重新发起一次。
- **本机 `npm view` 会滞后**：改完之后 `npm view ... dist-tags` 可能还显示旧的 `latest`（本机 packument 缓存），而 `curl https://registry.npmjs.org/-/package/@zhiliangtech%2fagentgate/dist-tags` 是即时的。以 registry 直连为准，或者换 `npm_config_cache`。

**这一步只有人能做**：写操作需要动态码，而 npm 的网页授权流程在非交互环境会立刻退出、auth URL 在日志里也是 `***`。发下一版时同样要有人执行一次 `npm dist-tag add`。

---

## 七、版本号要同步到哪些清单文件（2026-09-21 补：漏过一个）

**发一版要动的不止 `package.json`。** 每个对外条目都各自带一份写死的版本号，漏掉任何一个，
那边就永远停在你上一次记得改的版本上。

| 文件 | 谁在读它 | 改完还要做什么 |
| --- | --- | --- |
| `package.json` | npm | 打 tag 触发 CI 发版 |
| `server.json` | **官方 MCP registry** | `/tmp/mcp-publisher login github -token $(gh auth token)` 然后 `/tmp/mcp-publisher publish` |
| `lhm.plugin.json` | **LobeHub** | `npx @lobehub/market-cli@latest plugin update --dir .` |
| `docs/capabilities.md` | 我们自己能力页里那句 `agentgate x.y.z` | — |
| `README.md`、`docs/operations/pilot-package.md` | 给客户抄的命令 | — |

`docs/samples/evidence-pack-example/pack.json` 里也有版本号，**那是封了样的样例，不要动** ——
它的价值就在于封条还能验过。

### 2026-09-21 踩到的那个漏

0.5.0 发完之后查「还有哪里残留 0.4.0」，用的是 `grep -rn 0.4.0`。**`lhm.plugin.json` 因此没被查到
——它停在 `0.3.0`，比上一个版本还早。** 结果 LobeHub 那边跑了一次「更新」，回的是
`Updated ciceroyang-agentgate@0.3.0 (merged into the existing version)` —— 看起来成功了，其实没动。

**正确做法是 grep 版本号本身，不是 grep 上一个版本号**：

```sh
grep -rn '"version"\s*:\s*"0\.' --include="*.json" . | grep -v node_modules | grep -v "^./data/"
```

而且**要看每个 manifest 的返回值**：LobeHub 的 CLI 打印 `@0.3.0` 时就该停下来问一句为什么。

---

## 首次发布时验证的事实（历史记录，不是当前 registry 状态）

| 事 | 结果 | 怎么验的 |
| --- | --- | --- |
| `@zhiliangtech/agentgate` 是否被占 | **没被占**，registry 返回 404 | `curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/@zhiliangtech%2Fagentgate` |
| `@zhiliang` 是不是我们的 | **不是**：属于另一个账号；我们发布时 PUT 返回 404 | 2026-09-17 实际发布尝试 |
| 不带作用域的 `agentgate` | **已被占**（200），所以必须用作用域 | registry |
| `@zhiliangtech/agentgate` 的版本 | **0.1.0**（本机 bootstrap）、**0.1.1 / 0.1.2 / 0.2.0 / 0.2.3**（其余由 CI 发布，带 provenance；0.2.1、0.2.2 未上 npm） | `curl -sS https://registry.npmjs.org/-/package/@zhiliangtech%2Fagentgate/dist-tags` |
| `latest` 现在指向谁 | **0.2.0**（2026-09-18 核对；`next` 是 `0.2.3`） | `npm view @zhiliangtech/agentgate dist-tags` |
| 从 npm 装出来的包能不能跑 | **能**：`npx --yes @zhiliangtech/agentgate@0.1.1 version` 打印 `agentgate 0.1.1`；`npm i` 后 `node_modules/.bin/agentgate` 直接可执行；`check --root .` 正常给出 verdict | npx / `npm i`，2026-09-17 实测 |
| 0.1.1 有没有 provenance | **有**：attestations 两条（npm publish v0.1 与 SLSA provenance v1） | `curl -sS https://registry.npmjs.org/-/npm/v1/attestations/@zhiliangtech%2Fagentgate@0.1.1` |
| 打出来的包长什么样 | 123 个文件、394.5 kB、解开 1.8 MB | `npm publish --dry-run` |
| 从 tarball 解出来的包能不能跑 | **能**：解包后 `check` 和 `serve` 都通 | `node --test test/package.test.mjs` |
| 账号的 2FA | `auth-and-writes`（不开这个发布会被拒） | `npm profile get` |
| 一个坑：packument 的缓存 | 两处都会滞后：registry CDN 缓存发布前的"不存在"（`npm view` 报 404），以及**本机 `~/.npm` 里那份旧 packument**（`npm i @zhiliangtech/agentgate@0.1.1` 报 `ETARGET No matching version found`，npx 报 `command not found`，而 tarball 本身没问题）。`/-/package/<name>/dist-tags` 与搜索接口是即时准确的；换个 `npm_config_cache` 或等几分钟即自愈 | 实测（2026-09-17 两处都踩到，之后同一命令通过） |
| 一个坑：在 agentgate 源码目录里跑 npx | **会报 `command not found`**：cwd 的 `package.json` 名字本身就是 `@zhiliangtech/agentgate`，npx 于是当成本地包用，不去 registry 装，而本地没有 `node_modules/.bin/agentgate`。换个目录跑即可（别人的项目里不会遇到），或在源码目录里直接用 `node bin/agentgate.mjs` | 2026-09-17 实测（同一条命令换到 `/tmp` 立刻正常） |
