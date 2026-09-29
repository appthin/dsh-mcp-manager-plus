# Changelog

本插件的全部重要变更都记录在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

0.3.1 之前的开发发生在公开仓库建立之前，历史没有保留。

## [Unreleased]

### Fixed

- **内置能力的工具列表不再恒为空**：`toolsOfBuiltin` 原本只按服务键的 snake_case 前缀
  （`computerUse` → `computer_use_`）枚举，并无条件跳过所有 `mcp__` 开头的工具名。
  harness 现有的两个提供者都不符合该约定：MCP 版注册名为 `cua-driver-mcp`，工具被桥接
  成 `mcp__cua-driver-mcp__*`；native 版注册为 `cua_driver_native__*`。于是
  Computer Use 行虽然能被识别（服务存在），展开后永远显示 0 个工具。
  现在改为用服务自己发布的提供者名（`computerUse.providerName`）推导命名空间：
  MCP 提供者匹配 `mcp__<provider>__`，原生提供者匹配
  `<provider_with_underscores>__`；`${service}_` / `${service}-` 旧约定保留为兜底。
  前缀按字面匹配，因此不会把其它 MCP 服务器的工具计入内置行。
- **内置行列出它的 provider 子项，并且开关下移到子项**：每项带自己的状态（已连接 / 等待中并附
  它在等哪个注入服务 / 激活失败 / 已停用 / 无法载入），把原先塌成一句含糊说明的几种实况拆开
  显示。provider 是**互斥**的——选中一个会在同一次写入里关掉其余，单槽因此不会出现两个 claimant；
  能力行自己的开关去掉了（服务状态在行头已可见），"未启用"由所有子项都为停用推出。判据全部来自
  插件树——`disabled`、`fiber.state`、pending 时缺哪个注入服务——语义与 `inactiveEntries`
  完全一致（它同样跳过显式停用的行）。
- **provider 子项的重启有了自己的忙碌态，文案也走真实 key**：子项的忙碌判断原本用行自己的 id，
  子项重启时它永远为 false（按钮/开关不置灰 = "点了没反应"）；文案用了不存在的 `restarted` key，
  界面把 key 原样显示成 `restarted`。现在用 `restartDone`，并按 `child.id` 判定忙碌。
- **重启按钮始终可见**：不能重启时（已停用、等待注入服务）按钮**置灰并带原因提示**，而不是直接
  隐藏——隐藏会让人不知道这个操作到底存不存在。
- 「重启」下移到子项，并且**所有重启路径都换掉了实现**：`fiber.dispose()` + `init()` 会重接该 entry 的
  ctx 链，而 `disabled` 是派生值（沿 ctx 链对每层求值 `!!js` 表达式），于是某个祖先的表达式开始对它
  求值成 true —— 行**永久**报「已停用」而插件其实在正常跑（实测：fiber=2、工具数不变、`providerName`
  仍在；普通 MCP 行同样中招，只是它的面板读文件 flag，症状被掩盖）。这个坏状态还是**自锁**的：
  `update()` 里 `if (this.disabled) { dispose(); return; }`、`refresh()` 里 `if (this.disabled) return;`
  —— 一旦为真，entry 自己的 API 全部早退，只能由父级树整个重建。所以改为载入器唯一支持的路径：
  **写补丁层让它重新应用**（`disabled: true` → 等树确认 → `disabled: false` → 等确认），provider 子项、
  普通 MCP 行、遗留的能力行重启都走这一条。子项按行 id 直接定位，所以"失败的 provider"与"正在生效的
  provider"不同时也能重到对的那个；`failed` 显示「重试」，已停用（无 fiber）/ 等待中（只是在等注入
  服务）置灰。
- **内置行的工具名与 MCP 服务器行保持一致**：列表显示提供者自己的工具名
  （`click`、`get_window_state`），完整限定名保留在 `fullName` 中供悬停查看，
  与普通 MCP 服务器行的行为相同；此前内置行把完整限定名当作显示名。
- **按会话挂载的内置能力也能列出工具**：部分 provider（如 Browser Use 的
  `mountSessionMcp`）把 MCP 客户端挂在**每个 Agent 的作用域**内，root 作用域读不到。
  枚举内部改为先读 root，root 为空时再遍历活动 Agent 的 `ctx.tools.schemas(agent)`
  并去重——只读现成的活动会话，**不会**为了列表而创建会话或拉起浏览器。
- **空的内置行在展开处给出解释**：root 与活动会话都取不到工具时，面板在该行展开后的空态里
  说明原因（按会话挂载 / 未连接 / 被独占占用），而不是只显示「暂无工具」。
- 测试：新增「MCP 提供者的内置行列出自己命名空间下的工具」「按会话挂载的内置能力
  从活动 Agent 作用域列出工具」「空的内置行会被解释」「native 提供者按自己的下划线命名空间枚举」用例 127 项（另有一个组合套件在本机因运行时包 `@deepseek-ai/dsh-app-boot` 不可解析而无法加载，runner 现在会显式报出而不是静默吞掉）。

### Added

- **内置行的「重启」按钮现在真的能重启**：`restartServer` 原本只按
  `name === '@deepseek-ai/dsh-mcp-client'` + `config.serverName` 查找行，内置行必然报
  「未挂载，无法重启」。现在改用服务发布的 `providerName` 定位承载注册的那一行
  （provider 行的 id 以 `-<providerName>` 结尾）并就地 `_dispose()` + `init()`；
  切换 provider 后点一下「重启」即可生效，不必再分两步改配置。
  若单槽注册竞争导致 provider **根本没注册**（此时无从按名字定位），会退回到该能力自己的
  provider 行（`<service>-<provider>`，取启用的那条）重建；重建后 provider 仍未出现时明确报错，
  不再假报成功。
- **修复「重启」对所有行都无效**：`restartServer` 检查的 `entry._dispose` 在 cordis loader 里
  根本不存在（真实生命周期是 `entry.init()` + `entry.fiber.dispose()`），所以这个特性自发布起
  对**所有**行都只报「当前载入器不支持就地重启」。现在改用真实 API（`_dispose` 保留为兜底）
  并 `await` 掉 fiber 销毁，确保单槽服务在重新注册前已完成释放。
- **开关现在真的生效：任意行都改它自己块里的 `disabled`，停用后行不会消失**：能编辑的行直接改
  它自己块里的 `disabled`（内置能力行即 `- id: browser-use` / `- id: computer-use`），插件编辑
  不到的行（bundle 层提供的）才退回文件尾部的覆盖块。能力被停用后，provider 因 `inject`
  未满足而保持 pending。行的**存在性只由插件树决定**（`ctx.get('loader').entries()`，按 id 或
  服务包名匹配，不读配置文件），状态（启用/停用/阶段）同样取自该行及其 fiber，因此停用时
  行仍在、显示「已停用」并可再次开关。开关写/删的是该行**自己块内**的 `disabled`：行级外科式
  修改，块内注释原样保留，不再往文件尾部追加独立覆盖块；写完还会校验插件树是否真的变了，
  没变就明确报错，而不是写出一个内容相同的文件、静默地什么都没发生。
  开关在 `disabled: true` 与 `disabled: false` 之间切换，**始终写显式值**：删除 key 会让文件回到"已经被
  应用过"的字节，loader 就看不到变化。
  实测：载入器对"解析后配置有变化"的写入走**定点更新该行**，而这条路径**不能把一个已经停用的行重新
  启用**（"停用正常、启用卡死"就是它）；对"解析后配置没变化"的字节变化则走**整体重新应用**，那才能
  清掉陈旧状态。**定点更新运行期间还会把紧跟其后的补救一并吞掉**（实测：隔 1.2 秒后再补救才生效），
  所以开关写完会校验插件树，树没跟上时**等它跑完**再做同配置字节变化（翻转插件自己那行头部注释的一个
  字节）强制整体重应用，最多重试三次；仍不一致才报错「未生效：载入器没有重新组装，请重启 dsh」。
  但同一时间只能注册一个；服务会把该实现名发布为 `providerName`。面板现在把它显示在
  行标题上（如 `Computer Use（内置）· cua-driver-mcp`、`Browser Use（内置）· playwright-mcp`），
  响应中同时新增 `provider` 字段，未注册实现时为 `null`。

### Notes

- Browser Use 的工具随 Session 创建而挂载：**没有活动会话时该行仍会是 0 个工具**，
  此时会显示上面的配置提示。这是浏览器资源按会话独占的设计，不是本页的缺陷。

## [0.4.0] - 2026-09-17

### Added

- **多语言界面（中文 / English）**：页面头部新增语言切换器（自动 / 中文 / English）
  - 「自动」跟随 harness 界面语言；locale 服务不可达时按浏览器语言探测，兜底中文
  - 用户的选择持久化到 localStorage，刷新后依然有效
- **宿主端文案双语化**：每次 API 请求携带 `?lang=` 参数，服务名校验、重名/占用、
  导入汇总（如 `Recognized Codex configuration; Added github`）、重启提示、403/404
  等约 30 条消息跟随所选语言；不带参数时默认中文，旧行为不变
- 测试：新增 `lang=en` 英文响应与默认中文回归两个用例（总数 106 → 108）

## [0.3.1] - 2026-09-17

首个公开发布版本。

### Added

- **「MCP 管理」设置页**：在 DeepSeek Harness 设置界面侧边栏新增管理页面
  - 列表：展示配置文件中的 MCP 服务器、部署内置服务器与 Computer Use / Browser Use
    等内置能力
  - 展开：查看服务器当前注册到模型的全部工具及描述
  - 启用 / 停用：写入补丁层 `disabled` 覆盖，约 1 秒热生效，无需重启 dsh
  - 编辑：**表单**与 **JSON** 双模式随时切换；JSON 模式打开即预填当前配置，
    改服务名即为重命名（保留行 id 与启停覆盖）；一次粘贴多个服务器会被拒绝并列出名字
  - 重启：就地销毁并重新初始化连接，用于连接中断后恢复
  - 删除：从配置文件移除服务器及其全部覆盖行
- **一键导入**：粘贴 14 种主流工具的 MCP 配置自动识别——Claude Code、Cursor、
  Windsurf、Qoder、Cherry Studio、CodeBuddy、TRAE、ZCode、DeepSeek Harness、
  VS Code（`servers`）、Codex（**TOML**）、OpenCode（`mcp` + command 数组）、
  Continue（数组形式）、Pi；兼容 TOML、JSON 注释与尾逗号、`type:"sse"`、
  `serverUrl`、`http_headers` 等差异，单条失败不影响整段粘贴
- **侧边栏图标**：注册时即把导航行图标换成与外壳一致的链条图标
  （MutationObserver 预标记 + 页面挂载兜底），无需先点进页面
- **安全约定**：API 仅响应 loopback；写前整体校验、拒绝非法补丁文档；
  注释与无关条目逐字节保留；凭据形值（`KEY|PASSWORD|SECRET|TOKEN`）读取即掩码；
  部署内置行只读
- **测试**：7 个套件共 106 项（`node:test`，零依赖），覆盖补丁层解析、14 格式导入、
  JSON 编辑、宿主路由、bundle 加载、profile 组合与真实 profile 只读验证；
  另附 e2e 导入、往返校验、图标预览等辅助脚本

[0.4.0]: https://github.com/appthin/dsh-mcp-manager-plus/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/appthin/dsh-mcp-manager-plus/tree/v0.3.1
