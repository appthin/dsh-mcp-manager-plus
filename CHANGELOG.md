# Changelog

本插件的全部重要变更都记录在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

0.3.1 之前的开发发生在公开仓库建立之前，历史没有保留。

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
