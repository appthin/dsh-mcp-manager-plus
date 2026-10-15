# Changelog

本插件的全部重要变更都记录在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

0.3.1 之前的开发发生在公开仓库建立之前，历史没有保留。

## [0.4.4] - 2026-10-15

### Fixed

- **profile 顶层被提升到 `js-yaml` v5 时整页「加载失败：yaml.Type is not a constructor」**：
  `loadYaml()` 用 v3/v4 的自定义类型 API（`new yaml.Type(...)` + `schema.extend(...)`）
  承载 `!!js` 标签，而 `js-yaml` 一直是按 profile 锚点解析的——任何别的插件
  （如声明 `js-yaml@^5` 的插件）把 v5 提升到 profile 顶层后，`new yaml.Type(...)`
  就抛错，所有路由 500、面板完全不可用（感谢 @asfre 的报告与定位）。
  现在不再「谁先解析到就用谁」，而是在新增的 `lib/yaml.js` 里**探测能力**：
  一个副本构造不出 `!!js` 类型就跳过、继续沿锚点往下找，于是插件在
  `dependencies` 中钉住的 `js-yaml@^4.1.0` 会接管，而不是被顶层提升的 v5 拖垮
- **所有副本都不兼容时仍有兜底**：若插件目录与 profile 里没有任何能构造自定义类型的
  副本，也不再抛错，而是改用兼容解析——解析前把 `!!js` 标签替换成占位符、解析后再
  还原为表达式节点（扫描会跳过引号与注释内的文本，`args: ["echo !!js x"]`、
  `PLAIN: "!!js not a tag"` 这类值不会被误判成表达式）。面板因此照常加载与管理，
  且 `!!js` 语义不被改写：降级解析与快路径读出的值完全相同，回写的字节也完全一致
- 降级时在页面「配置提示」里写明实际解析到的 `js-yaml` 与降级状态，不再静默降级

### Added

- `dependencies` 新增 `js-yaml: ^4.1.0`：插件自带确定的副本，不再依赖 profile 顶层
  提升结果；解析顺序仍是 profile 锚点优先（与载入器 include 插件一致），只是不再
  接受一个无法承载 `!!js` 的副本
- 回归用例 `test/yaml.test.mjs`（11 项）：能力探测（`Type` 抛错、缺 `extend`、
  非对象等形态）、注入加载器验证「profile 锚点的不兼容副本让位于插件的可用副本」、
  完全没有可解析副本时报出明确错误，以及降级解析下 `!!js` 的行内 / 块 / 流式三种
  写法、「与快路径逐字节一致」、「回写后仍能通过校验并往返」
- 回归用例 `test/host.test.mjs`：在临时 profile 里放一个「v5 形状」（可解析、无自定义
  类型）的 `js-yaml`，`GET /servers` 必须仍返回 200 并列出种子行，而不是整页不可用
  （测试总数 115 → 127）

## [0.4.3] - 2026-10-09

### Fixed

- **安装路径含空格时补丁文件被误判为「不可写」**（DSH Desktop / Windows）：
  `fromFileUrl()` 用 `new URL().pathname` 读取路径，会保留百分号编码——DSH Desktop
  以 `file://` URL 传入 include 路径，`D:\DeepSeek Harness\` 因此变成
  `DeepSeek%20Harness`，指向一个并不存在的文件，`W_OK` 探测失败后页面报
  「配置文件不可写」并拒绝所有保存。现在改用 `fileURLToPath()`（解码 `%20`
  等转义，并正确处理 Windows 盘符前导斜杠与 UNC 主机），手动解析仅作兜底
  （感谢 @Lzh3070 的报告与定位）
- **暗色主题下主按钮白底白字、文字不可读**：`.mcpmp-btn-primary` 把前景硬编码成
  `#fff`，而背景用的 `--dsw-alias-brand-primary` 会随主题翻转（亮色 `#0f1115`、
  暗色 `#f9fafb`），暗色下于是成了白字配近白底。现在按 harness 自身主按钮的配对
  改用 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`
  （分别以 `brand-primary` / `label-primary-inverted` / `#fff` 兜底），hover 换成
  官方的 `--dsw-alias-button-primary-hover`，取代在近白底上几乎无效的
  `filter:brightness(1.08)`（感谢 @OTH-C3 的报告与定位）

### Added

- 回归用例：`file://` include 路径含 `%20` 时，`patchPath` 必须指向真实文件且
  `writable` 必须为 `true`；把 `lib/index.js` 还原成旧实现可复现该用例失败
- 回归用例：任何把「会随主题翻转的填充色」（`brand-primary` /
  `button-primary-fill`）与字面前景色写进同一条规则的样式都会被判失败
  （测试总数 113 → 115）

## [0.4.2] - 2026-09-30

### Fixed

- **`peerDependencies` 的版本范围在预发布版本上不成立**：上一版写的
  `>=0.1.6-alpha.1 <0.3.0` 在 pnpm 的默认语义（不含 `includePrerelease`）下会把
  `0.2.0-rc.1`、`0.2.0-rc.2` 这类预发布版本静默排除——node-semver 只放行
  「与范围内某个比较符同 `major.minor.patch` 且本身带预发布标签」的版本。
  于是 dsh-market 在其它机器上更新时报「插件声明的一个依赖版本范围在 registry 上
  没有可满足的版本」。已改为显式预发布分支：
  `>=0.1.6-alpha.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`，
  在 pnpm 默认语义与 harness 兼容门禁两种模式下都满足 `0.1.6-alpha.1` 与
  `0.2.0-rc.x`，并仍然拒绝 `0.3.0`

> 附：0.4.1 发布后 `registry.npmmirror.com` 镜像未同步到该版本，更新失败的另一半
> 原因是镜像缺版本；本版已重新发布并触发镜像同步。

## [0.4.1] - 2026-09-29

适配 dsh 0.2.0-rc.2（从 0.1.6-alpha.1 升级）。升级本身没有改动本插件使用的任何接口，
但升级同时把 `@deepseek-ai/cordis-plugin-loader` 从 1.0.3 抬到了 1.0.5，其中一处私有 API
被移除，故有此版本。

### Fixed

- **「重启」在 dsh 0.2.0-rc.2 上恒为失败**：旧代码用 loader 的私有
  `entry._dispose()` 重建行（0.1.6-alpha.1 携带的 loader 1.0.3 有该方法），
  而 0.2.0-rc.2 携带的 1.0.5 已将其删除，于是「重启」总是返回
  「当前载入器不支持就地重启，请重启 dsh 进程」。现在优先调用公开的
  `entry.fiber.restart()`，并保留 `_dispose()` + `init()` 分支兼容旧版 loader
- **测试不再依赖本机 profile 状态**：`test/live.test.mjs` 原先拿本机真实的
  `cordis.patch.yml` 判断行的启停，本机把 `dbx` 停用后，两个用例便误报
  `active`/`failed` 断言失败（实测：只删掉那一条停用覆盖即全部通过）。
  这两类用例改为在临时 profile 上运行，不再受本机状态影响

### Added

- 新增重启路径回归用例：分别覆盖 `fiber.restart()`、`_dispose()` + `init()`、
  fiber 已销毁、以及两种形态都不具备共 4 种情形；`live` 套件另补
  「patch 层停用优先于 loader 条目」和「部署提供的行仍被列出」两个用例
  （测试总数 108 → 113）
- **插件卡片元数据**：新增 `locale/zh.json` 与 `locale/en.json`（标题、描述）和
  `icon.svg`，并在 `package.json` 中声明 `icon` 与 `./locale/*.json` 导出。
  dsh 0.2.0 的插件市场卡片与设置页插件清单会直接读取它们，无需激活插件
- **`peerDependencies`**：声明 `@deepseek-ai/dsh: ">=0.1.6-alpha.1 <0.3.0"`
  （`optional: true`，不影响安装），让 dsh 的兼容性门禁能在运行时版本不匹配时明确报错，
  而不是静默加载

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

[0.4.4]: https://github.com/appthin/dsh-mcp-manager-plus/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/appthin/dsh-mcp-manager-plus/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/appthin/dsh-mcp-manager-plus/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/appthin/dsh-mcp-manager-plus/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/appthin/dsh-mcp-manager-plus/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/appthin/dsh-mcp-manager-plus/tree/v0.3.1
