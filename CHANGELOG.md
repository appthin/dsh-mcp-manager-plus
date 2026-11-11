# Changelog

本插件的全部重要变更都记录在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

0.3.1 之前的开发发生在公开仓库建立之前，历史没有保留。

## [0.5.0] - 2026-11-11

### Added

- **项目绑定**：把某个 MCP 服务器限定在指定的项目目录里，其它项目看不到、也调不动
  它的工具；清空路径即恢复全局可用。
  - 页面每行新增「项目绑定」入口（bundle 提供的行也可以绑，因为绑定表是本插件
    自己的数据）；弹窗每行填一个绝对路径，列表上以标签显示当前状态
    （「全局可用」/「仅限 N 个项目」），展开服务器时也有一条绑定摘要；
    已有绑定再点一次会预填当前路径，改完即生效；
  - 新增宿主路由 `POST /mcp-manager-plus/bind`；清单投影为每个服务器带上
    `binding: { paths, restricted }`，并回传绑定文件路径 `bindingsPath`；
  - 绑定数据写在
    `$DSH_HOME/profiles/<profile>/plugin-data/dsh-mcp-manager-plus/bindings.json`
    （可用环境变量 `DSH_MCP_MANAGER_BINDINGS` 指向别处）。**刻意不写补丁层**：
    补丁层决定运行中的插件树，写进去意味着每改一次绑定都要重新编排整棵树、重挂
    所有 MCP 连接；绑定只是本插件的数据，改完在运行中的进程里立刻生效；
  - 执行分两层：**会话作用域**的 `ctx.tools.restrict()` 把工具从该会话的可见集合里
    摘掉（所以工具列表里直接看不到），**根作用域**的 `ctx.tools.guard()` 再拦一次
    调用 —— 守卫在可扩展的 `tools/pre-execute` 放行之后运行，且没有任何守卫能把
    别人拒绝的调用改回允许，因此就算模型硬报一个工具名也执行不了；
  - 在 `agent/created` 与 `agent/pre-step` 两处同步：新会话、已经开着的会话、
    中途换了工作目录的会话都会被重新判定。目录取值顺序是
    `workingDirectory.get(session)` → 会话头的 `cwd` → `workingDirectory.defaultDirectory`；
  - 匹配规则：只认绝对路径，`~` 展开为主目录，Windows 下大小写不敏感、`/` 与 `\`
    等价、结尾分隔符可有可无；判定「就是它或在它下面」，所以绑定 `E:\work\alpha`
    不会放过名字只差前缀的兄弟目录 `E:\work\alphabeta`；
  - 有意留的边界（都写进了 README）：工作目录判断不出来时不拦截（宁可少拦一次，
    也不误伤）；`bindings.json` 缺失或损坏时按「没有绑定」处理，一次坏编辑不会让
    服务器在所有项目里都用不了；绑定按 **serverName** 记录，与补丁层的行 `id` 无关。
- 回归用例 18 项（测试总数 131 → 149）。项目绑定 14 项：清单投影与绑定文件不因读取
  而创建、绑定落盘与解除、路径归一化与去重、相对路径被拒、未知服务器被拒、守卫的
  放行/拒绝（含大小写、子目录、前缀兄弟目录、无会话、非 MCP 工具名、带下划线的
  serverName）、`agent/created` 与 `agent/pre-step` 的按会话限制与去重、改绑定后对
  活动会话的回收、目录判断不出来时两侧一致地不拦截、绑定文件损坏时照常可用，以及
  声明过的 effect 在 dispose 时全部撤销。图标按钮 4 项：四个动作共用同一个构造函数、
  三处标签载体齐备、样式表真的把 `data-tip` 画成提示且不参与命中；用户行不再渲染
  「配置文件」且该字典项已删除；绑定状态紧跟工具数量、来源标签只出现在非用户行；
  卡片不裁切、底角仍圆、悬停抬起。
- 三个预览脚本，用真实组件与真实样式表把这一块渲染成静态页，便于目测：
  `tools/preview-row.mjs`（各种行形态）、`tools/preview-actions.mjs`（逐个按钮 +
  3× 放大）、`tools/preview-tips.mjs`（提示越界与底角）。
- 重新截了 `screenshot1.jpg` / `screenshot5.jpg`，它们现在显示图标按钮与绑定状态。

### Changed

- **每行的操作按钮改为图标按钮**：编辑、重启、删除、项目绑定四个动作现在只画图标
  （铅笔 / 圆箭头 / 垃圾桶 / 带锁的文件夹），文字移到悬停提示里。名称同时写在
  `title`、`aria-label` 与 `data-tip` 上：`aria-label` 是读屏用的无障碍名称，
  `title` 是触控与不支持 CSS 时的原生提示，`data-tip` 由样式表画出更快、可截图的
  提示气泡（原生 `title` 要等约一秒）。提示在键盘聚焦时同样出现，且
  `pointer-events:none`，不会把触发它的悬停吃掉。按钮尺寸与原来一样是
  30×26（`.mcpmp-icon` 定宽，`.mcpmp-btn-sm` 定高），不会因为只剩图标而变小。
- **行尾那个「配置文件」标签去掉了**：用户自己的服务器是最常见的一行，这个标签只是
  把有用信息挤到第二行的噪音；服务器来源只对 bundle 行与内置行还有意义，所以它们的
  「部署内置」/「内置能力」标签保留。空出来的位置改放**项目绑定状态**
  （「全局可用」/「仅限 N 个项目」），已绑定时标签文字变绿、悬停可看目录；
  字典里随之失效的 `sourceUser` 已删除（中英两处）。
- `inject` 由 `['webServer']` 变为 `['webServer', 'tools']`：守卫与按会话限制就是本
  特性的执行方式，声明成硬依赖会让插件在缺少 `tools` 时停泊，而不是「挂载了却没有
  执行者」。
- README.md / README.en.md 增补「服务器行」与「项目绑定」两节、更新截图说明，
  并写明它不是沙箱、以及上面那些有意留的边界。

### Fixed

- **悬停提示会被卡片裁掉**：`.mcpmp-card` 原本靠 `overflow:hidden` 给底角收圆，
  而图标按钮的提示要画在按钮上方、越出卡片边界，于是被裁成两半。现在卡片不再裁切，
  底角改由 `> *:last-child` 自己承担；卡片同时建立堆叠上下文，悬停时抬高一层，
  提示不会被上面那张卡片盖住。

## [0.4.5] - 2026-11-08

### Fixed

- **DSH 0.2.2-rc.1 的设置侧边栏里，本行并排出现两个图标（左边链条例、右边齿轮）**：
  新版 shell 把导航行图标改成了 `settings.section.icon` 槽位，并把自己画的默认
  齿轮包进 `<span class="navIcon">`。于是旧的样式兜底
  （`button[data-mcpmp-nav]>svg:first-child` 隐藏 + `::before` 遮罩）既隐藏不掉
  齿轮，又照常画出自己的链条，两枚图标并排 —— 用户截图里的正是这一现象。
  现在**优先把图标注册进这个槽位**（注册 id 必须等于 section 的 id `mcp`，shell
  按行的 id 取用，取不到才回落到默认齿轮）；槽位存在时旧的「标记行 + 遮罩」整条
  链路直接关掉，行里只剩插件自己的链条图标。
- 没有该槽位的老版本（0.1.6-alpha.1 … 0.2.1）行为不变：页面照常注册，
  旧兜底仍接管这一行。

### Added

- 回归用例：槽位可用时图标注册进去（id 与 section 一致、尺寸跟随槽位、颜色走
  `currentColor`）；槽位可用时不再启动行标记（否则就是这次的双图标）；
  槽位缺失时页面仍注册、兜底仍在观察（测试总数 127 → 131）。

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
