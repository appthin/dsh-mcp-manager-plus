# dsh-mcp-manager-plus

MCP 服务器管理插件：在 DeepSeek Harness 设置界面的左侧边栏新增「MCP 管理」页面，
可直接查看、启用/停用、编辑、重启、删除与添加 MCP 服务器。

## 功能

| 能力 | 说明 |
| --- | --- |
| 列表 | 展示配置文件中的 MCP 服务器、部署内置服务器，以及 Computer Use / Browser Use 等内置能力 |
| 展开 | 点开一行查看该服务器当前注册到模型的所有工具及其描述 |
| 启用 / 停用 | 写入补丁层的 `disabled` 覆盖，约 1 秒内热生效，无需重启 dsh |
| 编辑 | 两种模式可随时切换：**表单**（逐字段）或 **JSON**（大输入框），见下节 |
| 重启 | 就地销毁并重新初始化该服务器的连接（配置不变），用于连接中断后恢复 |
| 删除 | 从配置文件中移除该服务器及其所有覆盖行 |
| 添加 | 粘贴**任意主流工具**的 MCP 配置即可，自动识别格式，支持一次导入多个（见下表） |

## 编辑时的两种模式

编辑已有服务器时，弹窗标题右侧有一个**分段开关**（带图标、带滑动指示块，`radiogroup` 语义，
支持左右方向键），随时可来回切换：

- **表单模式**：逐字段编辑（服务名、连接方式、命令、参数、环境变量、工作目录、URL、请求头）。
- **JSON 模式**：一个大输入框，**打开时已填入该服务器当前的配置**（而不是空框或示例），
  可以直接整段替换粘贴 —— 粘贴别处复制来的配置片段尤其方便。
  框上方有一份**可折叠的格式说明**，列出支持哪些工具、各自的容器键是什么，
  与「添加」弹窗共用同一个组件。

两种模式最终都写入同一行，因此：

- JSON 里**改服务名即为重命名**，该行会保留原来的 `id` 与启用/停用覆盖，不会多出一个副本；
- JSON 模式同样支持全部导入格式（含 Codex 的 TOML），因为格式解析与编辑/新增无关；
- 一次粘贴里出现**多个**服务器时会被拒绝并列出名字，避免「到底保存了哪个」的歧义；
- 切回表单模式时以磁盘上的行为准，不会带过去 JSON 框里改了一半的内容。

> 只有**已存在**的服务器才有 JSON 模式：JSON 保存是「更新指定的一行」，需要一个行名。
> 新增走「添加」按钮，它本来就是 JSON 模式。

格式说明里的容器键表（`FORMAT_ROWS`）与解析器必须一致，否则说明就是错的 ——
`test/client.test.mjs` 有一条测试把两边对起来验：表里每个键都真的能被解析，
解析器支持的 14 个工具名也都必须出现在表里。

## 支持导入的配置格式

粘贴时不需要改写，插件会识别容器键、字段名与文件语法：

| 工具 | 容器键 | stdio | 远程 | 备注 |
| --- | --- | --- | --- | --- |
| Claude Code · Cursor · Windsurf · Qoder · Cherry Studio · CodeBuddy · TRAE · ZCode | `mcpServers` | `command`/`args` | `url`/`headers` | 标准格式 |
| DeepSeek Harness（本插件自身） | `mcpServers` | `command`/`args` | `url`/`headers` | 原生格式 |
| VS Code | **`servers`** | `command`/`args` | `type:"http"` + `url` | 外层键不同 |
| Codex | `mcp_servers` | `command`/`args` | `url` | **TOML**，不是 JSON |
| OpenCode | `mcp` | `type:"local"`，**command 是数组** | `type:"remote"` + `url` | 结构差异最大 |
| Continue | `mcpServers` **数组** | `command`/`args` | — | 名字在条目里 |
| Pi | `mcpServers` + `settings` | `command`/`args` | `transport:"streamable-http"` | `settings` 会被忽略 |

另外还兼容这些差异：

- **TOML 输入**：Codex 的 `config.toml` 直接粘贴即可（含嵌套的 `[…​.env]` 表与行内注释）。
- **JSON 注释与尾逗号**：多个工具的文档示例带 `//`、`/* */` 和尾逗号，均可解析。
- **`type:"sse"`**：映射到本插件的 streamable-http 传输。
- **`serverUrl`**（Windsurf 的远程写法）、**`http_headers`**（Codex）、**command 数组**（OpenCode）
  都会被正确归位。
- **未知字段**：如 `enabled`、`lifecycle`、`description` 等不会导致导入失败，只是不写入配置。

导入时会报出识别到的来源，例如 `已识别 Codex 配置；新增 xxx`；单条失败只跳过该条，
并把它和失败原因一并列出，不会让整段粘贴白费。

## 配置写在哪里

插件的「唯一真相」是当前 profile 的用户补丁层：

```
$DSH_HOME/profiles/<profile>/cordis.patch.yml
```

新增一个 MCP 服务器就是向该文件追加一行 loader patch entry：

```yaml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_TOKEN: "…"
```

停用则是同级的 `disabled` 覆盖行：

```yaml
- id: mcp-github
  disabled: true
```

因为 profile 使用 `patchReload: live`，保存后 loader 会在约 1 秒内重新编排插件树，
所以配置改动**既是持久化的，也是热生效的** —— 插件本身不改动运行中的 loader 树，
只写文件，然后由浏览器端短暂轮询观察收敛后的实际状态。

## 安全约定

- **只响应本机请求。** API 挂在同一个 loopback web server 上，非 loopback 来源直接 403。
- **写入前必校验。** 每份候选文件都会重新解析为「顶层 loader patch 数组」，
  解析失败则拒绝写入，因此一次错误编辑不会让下次启动失败。
- **不碰不归它管的内容。** 文件是用户手写的：注释、无关条目、未知字段在改写后原样保留，
  只重写被改动的那一个块。
- **凭据不外传。** 形如 `KEY|PASSWORD|SECRET|TOKEN` 的配置值在读取时被掩码，
  浏览器回传掩码时再从原值还原，真实密钥不会出现在页面里。
- **部署内置的服务器只读。** 由 bundle 层提供的行可以停用/启用，但不能编辑或删除。

## 安装

```sh
dsh plugin --profile web add <本目录或包名>
```

随后重启 dsh（或等待 profile 热重载），在「设置 → MCP 管理」即可看到页面。

## 开发

```sh
node test/run.mjs          # 全部七个测试套件（共 106 项）
```

| 套件 | 覆盖范围 |
| --- | --- |
| `test/patch.test.mjs` | 补丁层分段、解析、校验、生成与逐字节往返 |
| `test/import.test.mjs` | 14 种工具的配置格式、TOML 子集、JSON 注释与尾逗号 |
| `test/editjson.test.mjs` | JSON 模式编辑：原地更新、重命名保留 id 与覆盖、多条拒绝 |
| `test/host.test.mjs` | 宿主端全部 HTTP 路由，用假的 Cordis 上下文驱动真实 `apply()` |
| `test/client.test.mjs` | 浏览器 bundle 能否被 shell 加载并注册设置页，含模式开关 |
| `test/compose.test.mjs` | 用真实的 bundle 层组合 profile，确认本插件的行能挂载 |
| `test/live.test.mjs` | 只读地跑真实 profile，确认线上配置能被正确读出且凭据已掩码 |

测试不依赖任何测试框架，只用 Node 内置的 `node:test`，并复用 profile 中已有的
`js-yaml`（与运行时同一条解析路径）。

### 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主端：HTTP API、清单投影、写操作 |
| `lib/import.js` | 导入解析：各工具配置格式 → 本插件的服务器形状 |
| `lib/patch.js` | 补丁层读写：分段、解析、校验、生成 |
| `lib/client.js` | 浏览器端：设置页面 UI（手写 lazy-CJS bundle，无构建步骤） |
| `cordis.patch.yml` | bundle 补丁，把本插件插入 profile 的层栈 |

### 辅助脚本

| 脚本 | 作用 |
| --- | --- |
| `node tools/e2e-import.mjs` | 起真实宿主端，把 14 种工具的配置逐个 POST 到 `/import`，再校验写出的补丁行 |
| `node tools/roundtrip-json.mjs` | 校验 JSON 模式预填的配置能原样往返（不改任何内容点确认不会丢字段） |
| `node tools/check-client-bundle.mjs` | 按 shell 的方式加载客户端 bundle，检查注册结果与导航图标 CSS |
| `node tools/check-segmented.mjs` | 校验分段开关的滑块几何（内缩、半宽、位移）与轨道假设一致 |
| `node tools/preview-edit-modes.mjs` | 用真实组件渲染编辑弹窗的两种模式，生成 `edit-modes-preview.html` |
| `node tools/check-nav-icon.mjs` | 校验导航图标的 mask 载荷是合法可绘制的 16×16 模板 |
| `node tools/gen-icon-preview.cjs` | 从 dsh 前端 bundle 提取图标，生成 `icon-options.html` 对照页 |
| `node tools/dump-icon.cjs <IconName>` | 打印某个内置图标的 SVG 路径，便于手写覆盖 |


### 为什么 `inject: ['slots']` 不能省

浏览器端插件必须把 `slots` 写进 `inject`。cordis 只会把**声明过**的服务在
`apply()` 之前解析好；没有声明时，`ctx.get('slots')` 即使在服务已经存在的情况下
也返回 `undefined`：

```js
exports.inject = ['slots'];   // ✅ apply() 运行时 ctx.slots 一定可用
exports.inject = [];          // ❌ ctx.get('slots') 恒为 undefined
```

后者不会报错，只会让「设置」侧边栏里**永远不出现**这个页面 —— 现象和「插件没装」
一模一样，极难排查。`test/client.test.mjs` 有两条回归测试守着这一点：一条把测试用的
假 Context 改成「只有声明过的服务才能作为属性读到」（并会剥离注释后再做静态匹配，
以免说明性文字被误判成代码），另一条要求服务缺失时**抛错**而不是静默返回。

### 侧边栏图标是怎么换的

settings 外壳按 **section id** 从一张硬编码表里挑导航图标，表里没有的 id 一律落到
通用齿轮（`general` 用的那个）：

```js
function navIcon(id) {
  if (id === "models") return IconDataOutline16
  if (id === "agent-presets") return IconAgentPresetOutline16
  if (id === "plugins") return IconPersonalizationOutline16
  if (id === "archived-sessions") return IconArchiveOutline20
  return IconSettingsOutline16   // ← 其它所有 id
}
```

插件的注册项没有「指定图标」这个字段，而且导航行的 DOM 上**没有 id 或 data-\* 属性**，
只有哈希类名（`VOzbGW_navCell`）。所以本插件的做法是：

1. 页面挂载时，从自己所在的 settings 面板里找标签等于本页 `nav` 文案的那一行，
   给它打上 `data-mcpmp-nav`（按标签自识别，因此别的插件在相邻 order 插入分区也不会认错行）；
2. 样式表隐藏该行原有的齿轮 `<svg>`，用 `::before` + **mask** 画出链条图标。

用 mask 而不是 background-image，是为了让图标自动继承行文字颜色，从而正确跟随
浅色/深色主题以及 hover / 选中态。图标路径取自外壳自身的 `IconLinkOutline16`，
保证视觉语言一致。

要换成别的图标：用 `node tools/dump-icon.cjs IconXxxOutline16` 打印路径，
替换 `lib/client.js` 里的 `NAV_ICON_PATHS` 即可；`icon-options.html` 里有 22 个候选的对照图。


## License

MIT
