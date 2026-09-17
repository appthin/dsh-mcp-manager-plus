// Browser half of dsh-mcp-manager-plus: the "MCP 管理" page inside Settings.
//
// Hand-written in the lazy-CJS bundle protocol
// (`window.__ModuleLoader__.load` with a factory returning cordis-plugin
// exports), so there is no build step. Everything it needs at runtime is
// already in the shell's frozen module table: React, plus the shared UI
// packages it declares under `dsh.client.external`.
//
// The page is deliberately self-contained: it renders its own markup and CSS
// rather than depending on product-internal components, so it keeps working
// across harness versions that rearrange those components. What it does depend
// on is one stable contract — `settings.section`, the additive settings page
// seat — and the HTTP API of its own host half.
//
// The host half owns the truth (the profile's patch file). This half renders
// it, collects form input, and polls briefly after a write, because a
// configuration change reaches the loader through the profile's file watcher:
// the write returns before the MCP server has mounted, so the tool list and
// connection phase settle a moment later.
window.__ModuleLoader__.load({
  id: 'dsh-mcp-manager-plus',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require('react');

    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;
    var useRef = react.useRef;

    var NS = 'dsh-mcp-manager-plus';

    /** Attribute this plugin stamps on its own settings nav row (see markNavRow). */
    var NAV_ROW_FLAG = 'data-mcpmp-nav';

    /** The dictionary, keyed for the two locales the harness ships. */
    var DICT = {
      zh: {
        nav: 'MCP 管理',
        title: 'MCP Servers 管理',
        description: '管理您已添加的 MCP 服务器，可启用、配置或添加新的工具能力。',
        refresh: '刷新',
        add: '添加',
        loading: '正在加载…',
        loadFailed: '加载失败',
        retry: '重试',
        empty: '还没有添加任何 MCP 服务器。',
        emptyHint: '点击右上角「添加」，粘贴任意工具的 MCP 配置（Claude Code / Cursor / VS Code / Codex / OpenCode 等）即可接入。',
        manualTitle: '手动配置',
        manualHint:
          '直接粘贴其它工具的 MCP 配置即可，无需改写：Claude Code、Cursor、VS Code、Codex、OpenCode、Continue、Pi、Cherry Studio、Windsurf、Qoder、CodeBuddy、TRAE、ZCode、DeepSeek Harness 的格式都能识别（含 TOML 与带注释的 JSON）。',
        manualPlaceholder:
          '// 示例：Claude Code / Cursor / Windsurf / Qoder 等\n{\n  "mcpServers": {\n    "example-server": {\n      "command": "npx",\n      "args": ["-y", "mcp-server-example"]\n    }\n  }\n}\n\n// VS Code 用 "servers"，Codex 用 TOML 的 [mcp_servers.x]，\n// OpenCode 用 "mcp" + type:"local"/"remote" —— 都可以直接粘贴。',
        manualWarn: '配置前请确认来源，甄别风险',
        editJsonTitle: '编辑 MCP 服务器（JSON）',
        editJsonHint: '直接编辑该服务器的 JSON 配置。改服务名即为重命名，原有行与其启用/停用状态都会保留；修改后可切回表单模式查看。',
        modeLabel: '配置模式',
        modeForm: '表单',
        modeJson: 'JSON',
        formatsSummary: '支持粘贴以下工具的 MCP 配置（点开查看容器键）',
        formatsFooter: '键名不同也能识别，无需改写；支持 JSON 注释与尾逗号。',
        cancel: '取消',
        close: '关闭',
        confirm: '确认',
        saving: '保存中…',
        edit: '编辑',
        restart: '重启',
        remove: '删除',
        removeConfirm: '确定要删除「{name}」吗？此操作会从配置文件中移除该服务器。',
        editTitle: '编辑 MCP 服务器',
        addTitle: '添加 MCP 服务器',
        name: '服务名',
        nameHint: '仅字母、数字、下划线和连字符，1–32 个字符。工具名前缀为 mcp__<名称>__。',
        transport: '连接方式',
        transportStdio: 'STDIO（本地命令）',
        transportHttp: 'Streamable HTTP（远程地址）',
        command: '命令',
        commandHint: '例如 npx、uvx，或可执行文件的绝对路径。',
        args: '参数',
        argsHint: '每行一个参数。',
        env: '环境变量',
        envHint: '每行一个 KEY=VALUE。',
        cwd: '工作目录',
        cwdHint: '可选；留空则继承当前工作目录。',
        url: 'URL',
        urlHint: '例如 http://localhost:3000/mcp',
        headers: '请求头',
        headersHint: '每行一个 KEY=VALUE。',
        toolCount: '{n} 个工具',
        phaseActive: '已连接',
        phasePending: '等待中',
        phaseLoading: '连接中',
        phaseFailed: '连接失败',
        phaseDisabled: '已停用',
        phaseUnloading: '卸载中',
        sourceUser: '配置文件',
        sourceBundle: '部署内置',
        sourceBuiltin: '内置能力',
        notWritable: '配置文件不可写，改动无法保存：{path}',
        issues: '配置提示',
        saved: '已保存',
        removed: '已删除',
        imported: '已导入',
        restartDone: '已重启 {name}',
        noTools: '暂无工具（服务器可能未连接，或未提供任何工具）',
        expand: '展开',
        collapse: '收起',
        langLabel: '语言',
        langAuto: '自动',
      },
      en: {
        nav: 'MCP',
        title: 'MCP Servers',
        description: 'Manage the MCP servers you have added — enable, configure, or add new tool capabilities.',
        refresh: 'Refresh',
        add: 'Add',
        loading: 'Loading…',
        loadFailed: 'Failed to load',
        retry: 'Retry',
        empty: 'No MCP servers added yet.',
        emptyHint: 'Use “Add” to paste an MCP configuration from any tool (Claude Code, Cursor, VS Code, Codex, OpenCode, …).',
        manualTitle: 'Manual configuration',
        manualHint:
          'Paste an MCP configuration from any of these tools as-is — no rewriting: Claude Code, Cursor, VS Code, Codex, OpenCode, Continue, Pi, Cherry Studio, Windsurf, Qoder, CodeBuddy, TRAE, ZCode and DeepSeek Harness (TOML and JSON-with-comments included).',
        manualPlaceholder:
          '// Example: Claude Code / Cursor / Windsurf / Qoder etc.\n{\n  "mcpServers": {\n    "example-server": {\n      "command": "npx",\n      "args": ["-y", "mcp-server-example"]\n    }\n  }\n}\n\n// VS Code uses "servers", Codex uses TOML [mcp_servers.x],\n// OpenCode uses "mcp" with type:"local"/"remote" — paste any of them.',
        manualWarn: 'Verify the source and assess the risk before configuring.',
        editJsonTitle: 'Edit MCP server (JSON)',
        editJsonHint: 'Edit this server’s JSON configuration directly. Renaming it here renames the row, keeping its id and its enabled/disabled state; switch back to the form to review it.',
        modeLabel: 'Configuration mode',
        modeForm: 'Form',
        modeJson: 'JSON',
        formatsSummary: 'Accepts MCP configuration pasted from these tools (expand to see the container key)',
        formatsFooter: 'Different key names are understood as-is — no rewriting needed. JSON comments and trailing commas are fine too.',
        cancel: 'Cancel',
        close: 'Close',
        confirm: 'Confirm',
        saving: 'Saving…',
        edit: 'Edit',
        restart: 'Restart',
        remove: 'Delete',
        removeConfirm: 'Delete “{name}”? This removes the server from the configuration file.',
        editTitle: 'Edit MCP server',
        addTitle: 'Add MCP server',
        name: 'Server name',
        nameHint: 'Letters, digits, underscore and hyphen only, 1–32 characters. Prefixes tools as mcp__<name>__.',
        transport: 'Transport',
        transportStdio: 'STDIO (local command)',
        transportHttp: 'Streamable HTTP (remote URL)',
        command: 'Command',
        commandHint: 'For example npx, uvx, or an absolute executable path.',
        args: 'Arguments',
        argsHint: 'One argument per line.',
        env: 'Environment',
        envHint: 'One KEY=VALUE per line.',
        cwd: 'Working directory',
        cwdHint: 'Optional; inherits the current directory when empty.',
        url: 'URL',
        urlHint: 'For example http://localhost:3000/mcp',
        headers: 'Headers',
        headersHint: 'One KEY=VALUE per line.',
        toolCount: '{n} tools',
        phaseActive: 'Connected',
        phasePending: 'Pending',
        phaseLoading: 'Connecting',
        phaseFailed: 'Failed',
        phaseDisabled: 'Disabled',
        phaseUnloading: 'Unloading',
        sourceUser: 'Config file',
        sourceBundle: 'Deployment',
        sourceBuiltin: 'Built-in',
        notWritable: 'The configuration file is not writable, so changes cannot be saved: {path}',
        issues: 'Notes',
        saved: 'Saved',
        removed: 'Removed',
        imported: 'Imported',
        restartDone: 'Restarted {name}',
        noTools: 'No tools yet (the server may be disconnected, or exposes none).',
        expand: 'Expand',
        collapse: 'Collapse',
        langLabel: 'Language',
        langAuto: 'Auto',
      },
    };

    /** Translate one key, interpolating `{name}` placeholders. */
    function makeT(locale) {
      var table = DICT[locale === 'en' ? 'en' : 'zh'];
      return function t(key, params) {
        var text = table[key] !== undefined ? table[key] : DICT.zh[key] !== undefined ? DICT.zh[key] : key;
        if (params === undefined) return text;
        return text.replace(/\{(\w+)\}/g, function (match, name) {
          return params[name] !== undefined ? String(params[name]) : match;
        });
      };
    }

    // The settings shell picks a nav-row icon from its own hard-coded table
    // keyed by section id, and every id it does not know — `mcp` included —
    // falls through to the same generic gear `general` uses. The two chain
    // links below are the shell's own `IconLinkOutline16` geometry, copied
    // verbatim so the row matches the rest of the sidebar's visual language.
    // They are filled (not stroked) because that is how the shipped icon draws.
    var NAV_ICON_PATHS = [
      'M9.94133 6.50173C11.3218 7.99603 11.3218 10.3011 9.94128 11.7954C9.88691 11.8542 9.82125 11.9196 9.72099 12.0198L7.75707 13.9838C7.65709 14.0838 7.592 14.1491 7.53334 14.2034C6.03906 15.5843 3.7327 15.5854 2.23827 14.2048C2.17933 14.1503 2.11374 14.0844 2.01315 13.9838C1.91318 13.8839 1.84922 13.8188 1.79495 13.7601C0.413857 12.2657 0.413909 9.95948 1.795 8.46503C1.84923 8.4064 1.91335 8.34115 2.01321 8.24129L3.79275 6.46313C3.71814 7.08101 3.75236 7.71445 3.90115 8.33518L3.00344 9.23151C2.89398 9.34097 2.8535 9.38307 2.82251 9.41658C1.93771 10.3744 1.93704 11.8514 2.82179 12.8092C2.85279 12.8427 2.89383 12.884 3.0034 12.9936C3.11272 13.1029 3.15429 13.1442 3.18777 13.1752C4.14561 14.0603 5.62381 14.0608 6.58178 13.1758C6.61532 13.1448 6.65722 13.1032 6.76685 12.9935L8.73077 11.0296C8.83999 10.9204 8.88142 10.8787 8.91238 10.8452C9.79744 9.88728 9.7969 8.40911 8.91173 7.45124C8.88074 7.41775 8.83944 7.3762 8.73011 7.26687C8.62082 7.15757 8.58061 7.11623 8.54712 7.08526C8.37347 6.92477 8.18243 6.79361 7.98088 6.69165L9.00289 5.66964C9.17506 5.78373 9.34035 5.91265 9.49663 6.05703C9.55538 6.11135 9.62026 6.17652 9.72036 6.27662C9.82094 6.3772 9.88686 6.4428 9.94133 6.50173Z',
      'M6.06816 9.49196C4.68626 7.99724 4.68667 5.68942 6.06885 4.19487C6.12268 4.13671 6.18789 4.07306 6.28706 3.9739L8.24541 2.01416C8.34478 1.91479 8.41018 1.85055 8.46845 1.79665C9.96301 0.414902 12.2689 0.414922 13.7635 1.79665C13.8217 1.85051 13.8866 1.91559 13.9858 2.01486C14.0849 2.11394 14.1502 2.17769 14.204 2.23583C15.5861 3.7304 15.5866 6.03823 14.2047 7.53291C14.1508 7.59125 14.0854 7.65638 13.9858 7.75595L12.1994 9.54098C12.2614 8.92982 12.2185 8.30587 12.0634 7.69657L12.9956 6.76573C13.1044 6.65692 13.1458 6.61529 13.1765 6.58205C14.0621 5.62404 14.0621 4.1454 13.1765 3.18738C13.1458 3.15419 13.104 3.1135 12.9956 3.00508C12.8877 2.89716 12.8471 2.85551 12.814 2.82485C11.8559 1.9389 10.376 1.93886 9.41794 2.82485C9.38479 2.85554 9.34381 2.89622 9.23564 3.00439L7.27728 4.96413C7.16875 5.07265 7.12708 5.11322 7.09636 5.14643C6.21074 6.10441 6.21153 7.58236 7.09705 8.5404C7.12775 8.57357 7.16826 8.61575 7.27659 8.72408C7.38456 8.83205 7.42647 8.87227 7.45958 8.90293C7.62849 9.0591 7.81309 9.1881 8.00856 9.28894L6.98795 10.3095C6.82111 10.1978 6.66052 10.0715 6.50872 9.93114C6.45057 9.87733 6.38547 9.81341 6.28637 9.71431C6.1871 9.61504 6.12202 9.55018 6.06816 9.49196Z',
    ];

    /** The one stylesheet the page injects, using the theme's alias tokens. */
    var CSS = [
      '.mcpmp-root{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.mcpmp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.mcpmp-head h2{margin:0 0 4px;font-size:15px;font-weight:600}',
      '.mcpmp-head p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.mcpmp-lang{display:inline-flex;align-items:center;gap:2px;height:30px;padding:0 2px 0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mcpmp-lang-glyph{font-size:11px;letter-spacing:-1px;white-space:nowrap}',
      '.mcpmp-lang select{border:none;background:transparent;color:inherit;font:inherit;height:26px;outline:none;cursor:pointer}',
      '.mcpmp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap}',
      '.mcpmp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.mcpmp-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.mcpmp-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.mcpmp-btn-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-brand-primary)}',
      '.mcpmp-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.mcpmp-btn-sm{height:26px;padding:0 9px;font-size:12px}',
      '.mcpmp-icon{width:30px;padding:0}',
      '.mcpmp-list{display:flex;flex-direction:column;gap:8px}',
      '.mcpmp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.mcpmp-row{display:flex;align-items:center;gap:10px;padding:10px 12px;min-height:52px}',
      '.mcpmp-avatar{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex:0 0 auto;text-transform:uppercase}',
      '.mcpmp-name{display:flex;align-items:center;gap:6px;font-weight:500;min-width:0}',
      '.mcpmp-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mcpmp-meta{color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}',
      '.mcpmp-grow{flex:1 1 auto;min-width:0}',
      '.mcpmp-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.mcpmp-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex:0 0 auto;background:var(--dsw-alias-label-secondary)}',
      '.mcpmp-dot-active{background:var(--dsw-alias-state-success-primary)}',
      '.mcpmp-dot-failed{background:var(--dsw-alias-state-error-primary)}',
      '.mcpmp-dot-loading,.mcpmp-dot-pending{background:var(--dsw-alias-state-warn-primary)}',
      '.mcpmp-switch{position:relative;width:38px;height:22px;border-radius:11px;border:none;background:var(--dsw-alias-border-l2);cursor:pointer;padding:0;flex:0 0 auto;transition:background .15s ease}',
      '.mcpmp-switch[data-on="true"]{background:var(--dsw-alias-state-success-primary)}',
      '.mcpmp-switch:disabled{opacity:.5;cursor:not-allowed}',
      '.mcpmp-switch i{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s ease}',
      '.mcpmp-switch[data-on="true"] i{transform:translateX(16px)}',
      '.mcpmp-caret{width:20px;height:20px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto;transition:transform .15s ease}',
      '.mcpmp-tools{border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);max-height:320px;overflow:auto}',
      '.mcpmp-tool{display:grid;grid-template-columns:minmax(140px,220px) 1fr;gap:12px;padding:7px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mcpmp-tool:last-child{border-bottom:none}',
      '.mcpmp-tool code{font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all}',
      '.mcpmp-tool p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mcpmp-tools-empty{padding:10px 14px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.mcpmp-note{padding:9px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.mcpmp-note-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.mcpmp-note-error{color:var(--dsw-alias-state-error-primary)}',
      '.mcpmp-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32);padding:24px}',
      '.mcpmp-modal{width:min(640px,100%);max-height:86vh;display:flex;flex-direction:column;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 12px 40px rgba(0,0,0,.28)}',
      '.mcpmp-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mcpmp-modal-head h3{margin:0;font-size:14px;font-weight:600;flex:1;min-width:0}',
      // Mode switch: a segmented control with a sliding pill. The pill is a
      // separate element so it can animate, and each option keeps its own
      // size so the labels never shift while the pill moves.
      '.mcpmp-seg{position:relative;display:inline-flex;flex:none;padding:3px;gap:0;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
      '.mcpmp-seg-pill{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px)/2);border-radius:6px;background:var(--dsw-alias-bg-overlay);box-shadow:0 1px 3px rgba(0,0,0,.10);transition:transform .18s cubic-bezier(.4,0,.2,1)}',
      '.mcpmp-seg[data-index="1"] .mcpmp-seg-pill{transform:translateX(100%)}',
      '.mcpmp-seg-btn{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;flex:1;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:4px 12px;border-radius:6px;cursor:pointer;white-space:nowrap;transition:color .18s ease}',
      '.mcpmp-seg-btn:hover{color:var(--dsw-alias-label-primary)}',
      '.mcpmp-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.mcpmp-seg-on,.mcpmp-seg-on:hover{color:var(--dsw-alias-label-primary);font-weight:500}',
      // Accepted paste formats: collapsed by default so the box stays the
      // focus, expanded for anyone who needs the per-tool container key.
      '.mcpmp-formats{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px}',
      '.mcpmp-formats>summary{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:pointer;color:var(--dsw-alias-label-secondary);list-style:none}',
      '.mcpmp-formats>summary::-webkit-details-marker{display:none}',
      '.mcpmp-formats>summary:hover{color:var(--dsw-alias-label-primary)}',
      '.mcpmp-formats>summary svg{transition:transform .18s ease;flex:none}',
      '.mcpmp-formats[open]>summary svg{transform:rotate(180deg)}',
      '.mcpmp-formats[open]>summary{border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mcpmp-formats-grid{display:flex;flex-direction:column;gap:1px;padding:6px 10px}',
      '.mcpmp-format{display:grid;grid-template-columns:1fr auto auto;align-items:baseline;gap:8px;padding:3px 0}',
      '.mcpmp-format-tools{color:var(--dsw-alias-label-primary);font-size:12px}',
      '.mcpmp-format code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.mcpmp-format em{color:var(--dsw-alias-label-secondary);font-size:11px;font-style:normal;white-space:nowrap}',
      '.mcpmp-formats-foot{margin:0;padding:7px 10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.mcpmp-modal-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:12px}',
      '.mcpmp-modal-body p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.mcpmp-modal-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.mcpmp-field{display:flex;flex-direction:column;gap:5px}',
      '.mcpmp-field label{font-size:12px;font-weight:500}',
      '.mcpmp-field small{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.mcpmp-input,.mcpmp-select,.mcpmp-textarea{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;padding:7px 9px;font-family:inherit}',
      '.mcpmp-textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;line-height:1.55;resize:vertical}',
      '.mcpmp-input:focus,.mcpmp-select:focus,.mcpmp-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '@media (max-width:640px){.mcpmp-tool{grid-template-columns:1fr;gap:2px}}',
      // ── settings nav row icon ────────────────────────────────────────────
      // The shell draws a generic gear for any section id it does not know,
      // and offers no way to supply a different one. Our row is tagged with
      // NAV_ROW_FLAG by markNavRow; hide the shell's gear in that row and
      // paint the chain-link glyph instead. The glyph rides a mask so it
      // inherits `currentColor` exactly like every other nav icon, in both
      // themes, with no extra element to keep in sync.
      'button[' + NAV_ROW_FLAG + ']>svg:first-child{display:none}',
      'button[' + NAV_ROW_FLAG + ']::before{content:"";flex:none;width:16px;height:16px;background-color:currentColor;'
        + '-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;'
        + '-webkit-mask-size:16px 16px;mask-size:16px 16px;'
        + '-webkit-mask-image:url("' + navIconDataUrl() + '");mask-image:url("' + navIconDataUrl() + '")}',
    ].join('\n');

    /**
     * The nav glyph as a data-URL mask image.
     *
     * A mask (rather than a background image) is what lets the glyph take the
     * row's own text colour — including the active and hover states the shell
     * styles — without hard-coding a colour per theme.
     * @returns a `url("data:…")` value holding the link icon.
     */
    function navIconDataUrl() {
      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">'
        + NAV_ICON_PATHS.map(function (d) {
          return '<path d="' + d + '" fill="#000"/>';
        }).join('')
        + '</svg>';
      // encodeURIComponent keeps the payload readable and quote-safe.
      return 'data:image/svg+xml,' + encodeURIComponent(svg);
    }

    /** Insert the page stylesheet once per client module instance. */
    function installStyles() {
      var id = NS + '-styles';
      if (document.getElementById(id) !== null) return;
      var tag = document.createElement('style');
      tag.id = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * Render one server as the `mcpServers` JSON everyone pastes.
     *
     * The JSON editor opens on the server being edited, so the starting point
     * has to be that server's own configuration rather than an empty box or a
     * generic sample. Only the fields the server actually uses are emitted, so
     * a stdio server does not open with an empty `url` beside it.
     * @param server - one inventory row.
     * @returns pretty-printed JSON text.
     */
    function serverToJson(server) {
      var entry = {};
      if (server.transport === 'streamable-http') {
        entry.url = server.url || '';
        if (server.headers && Object.keys(server.headers).length > 0) entry.headers = server.headers;
      } else {
        entry.command = server.command || '';
        if (server.args && server.args.length > 0) entry.args = server.args;
        if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
        if (server.cwd) entry.cwd = server.cwd;
      }
      var document = { mcpServers: {} };
      document.mcpServers[server.serverName] = entry;
      return JSON.stringify(document, null, 2);
    }

    /** A stable avatar colour per server name, so rows stay recognisable. */
    function avatarColor(name) {
      var palette = ['#E8A33D', '#4C7EF3', '#3BB273', '#C4553C', '#8B5CF6', '#0EA5E9'];
      var sum = 0;
      for (var i = 0; i < name.length; i += 1) sum = (sum * 31 + name.charCodeAt(i)) % 997;
      return palette[sum % palette.length];
    }

    /** The avatar letter for a name (its first alphanumeric character). */
    function avatarLetter(name) {
      var match = /[A-Za-z0-9]/.exec(name);
      return match === null ? '?' : match[0];
    }

    /** Split a textarea's lines into a string array, dropping empties. */
    function linesToArray(text) {
      return String(text)
        .split(/\r?\n/)
        .map(function (line) {
          return line.trim();
        })
        .filter(function (line) {
          return line !== '';
        });
    }

    /** Parse KEY=VALUE lines into a map; a line without `=` is dropped. */
    function linesToMap(text) {
      var map = {};
      linesToArray(text).forEach(function (line) {
        var index = line.indexOf('=');
        if (index <= 0) return;
        map[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      });
      return map;
    }

    /** Render a map back to KEY=VALUE lines, including host-masked values. */
    function mapToLines(map) {
      if (map === null || typeof map !== 'object') return '';
      return Object.keys(map)
        .map(function (key) {
          return key + '=' + String(map[key]);
        })
        .join('\n');
    }

    /** The HTTP API prefix this plugin's host half registers. */
    var API_PREFIX = '/mcp-manager-plus';

    /**
     * Call the host half over its loopback HTTP API. A regular client plugin
     * talks to its host through `fetch` (the `host.call` bridge belongs to
     * dynamic Cordis Packages); the route is same-origin, so no credential or
     * proxy handling is involved.
     * @param route - API route without the prefix, e.g. `servers`.
     * @param body - JSON body; a GET is issued when it is absent.
     * @returns the decoded JSON response.
     */
    function api(route, body) {
      var isRead = body === undefined;
      // Host-side messages follow the page's effective language.
      var query = '?lang=' + (localeRef.current === 'en' ? 'en' : 'zh');
      return fetch(API_PREFIX + '/' + route + query, {
        method: isRead ? 'GET' : 'POST',
        headers: isRead ? undefined : { 'content-type': 'application/json' },
        body: isRead ? undefined : JSON.stringify(body),
      }).then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (payload) {
            if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status);
            return payload;
          });
      });
    }

    // ── small presentational pieces ────────────────────────────────────────

    /** Inline SVG icon: one path, stroked in the current text colour. */
    function Icon(props) {
      return h(
        'svg',
        {
          width: props.size || 14,
          height: props.size || 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        props.path,
      );
    }

    var ICON_PATH = {
      plus: h('path', { d: 'M8 3v10M3 8h10' }),
      refresh: h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V5H11' }),
      chevron: h('path', { d: 'M4 6l4 4 4-4' }),
      close: h('path', { d: 'M4 4l8 8M12 4l-8 8' }),
      // Mode-switch glyphs: a form (label rows) and code brackets. Each is a
      // single <path> with several subpaths, so no React `key` is needed —
      // `key` is not forwarded to the DOM, but avoiding it keeps the elements
      // simple and the preview faithful.
      form: h('path', { d: 'M2.5 4h3M2.5 8h3M2.5 12h3M7.5 4h6M7.5 8h6M7.5 12h6' }),
      code: h('path', { d: 'M6 4L2.5 8 6 12M10 4l3.5 4L10 12' }),
    };

    /**
     * Mark this plugin's own nav row so the stylesheet can swap its icon.
     *
     * The shell renders nav rows without any id or data attribute, so the row
     * cannot be selected from CSS directly. The page it renders is mounted
     * inside that very row's panel, which gives a stable way back: walk up
     * from the page element to the settings panel, then tag the nav cell whose
     * label matches this page's own nav text. Tagging (rather than an
     * `:nth-child` guess) keeps working when another plugin inserts a section
     * at a neighbouring order, and it never touches a row that is not ours.
     *
     * @param root - the mounted page element.
     * @returns a disposer that removes the marker.
     */
    function markNavRow(root) {
      if (root === null || typeof root.closest !== 'function') return function () {};
      var label = makeT(localeRef.current)('nav');
      // The page is mounted inside the settings panel, so the panel is the
      // shortest scope that still contains the nav list this row belongs to.
      var panel = root.closest('[class*="panel"]');
      var scope = panel === null ? document : panel;
      var cells = scope.querySelectorAll('button[class*="navCell"]');
      var row = null;
      for (var i = 0; i < cells.length; i += 1) {
        var text = cells[i].textContent;
        if (text !== null && text.trim() === label) {
          row = cells[i];
          break;
        }
      }
      if (row === null) return function () {};
      row.setAttribute(NAV_ROW_FLAG, '');
      return function () {
        row.removeAttribute(NAV_ROW_FLAG);
      };
    }

    /**
     * Flag this plugin's nav row as soon as the shell renders it.
     *
     * markNavRow can only run once this page mounts — after the user first
     * clicks the row — so until then the row still wears the shell's default
     * gear. The shell offers no hook for "nav list rendered", so watch the
     * document instead: whenever nodes change, tag the nav cell whose label
     * matches this page's nav text. The page-level effect stays as a fallback
     * for environments without MutationObserver; here a missing flag is only
     * ever set, never removed, so mutations cannot ping-pong.
     *
     * @returns a disposer that disconnects the observer.
     */
    function watchNavRow() {
      if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
        return function () {};
      }
      var scheduled = false;
      function scan() {
        scheduled = false;
        var label = makeT(localeRef.current)('nav');
        var cells = document.querySelectorAll('button[class*="navCell"]');
        for (var i = 0; i < cells.length; i += 1) {
          var text = cells[i].textContent;
          if (text !== null && text.trim() === label && !cells[i].hasAttribute(NAV_ROW_FLAG)) {
            cells[i].setAttribute(NAV_ROW_FLAG, '');
          }
        }
      }
      function schedule() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(scan, 100);
      }
      var observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      schedule();
      return function () {
        observer.disconnect();
      };
    }

    /** The row switch, styled as the pill toggle the rest of the UI uses. */
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'mcpmp-switch',
          'data-on': props.checked ? 'true' : 'false',
          role: 'switch',
          'aria-checked': props.checked,
          'aria-label': props.label,
          disabled: props.disabled,
          onClick: props.onChange,
        },
        h('i', null),
      );
    }

    /** One expandable server row, with its tool list beneath it. */
    function ServerCard(props) {
      var t = props.t;
      var server = props.server;
      var busy = props.busy;
      var expanded = props.expanded;
      var live = server.live || {};
      var phase = live.phase || 'pending';
      var phaseLabel =
        {
          active: t('phaseActive'),
          loading: t('phaseLoading'),
          pending: t('phasePending'),
          failed: t('phaseFailed'),
          disabled: t('phaseDisabled'),
          unloading: t('phaseUnloading'),
        }[phase] || phase;
      var tools = Array.isArray(live.tools) ? live.tools : [];
      var sourceLabel =
        server.source === 'user'
          ? t('sourceUser')
          : server.source === 'builtin'
            ? t('sourceBuiltin')
            : t('sourceBundle');

      var actions = [];
      if (server.editable) {
        actions.push(
          h(
            'button',
            { key: 'edit', type: 'button', className: 'mcpmp-btn mcpmp-btn-sm', disabled: busy, onClick: props.onEdit },
            t('edit'),
          ),
        );
      }
      if (live.mounted) {
        actions.push(
          h(
            'button',
            {
              key: 'restart',
              type: 'button',
              className: 'mcpmp-btn mcpmp-btn-sm',
              disabled: busy,
              onClick: props.onRestart,
            },
            t('restart'),
          ),
        );
      }
      if (server.removable) {
        actions.push(
          h(
            'button',
            {
              key: 'remove',
              type: 'button',
              className: 'mcpmp-btn mcpmp-btn-sm mcpmp-btn-danger',
              disabled: busy,
              onClick: props.onRemove,
            },
            t('remove'),
          ),
        );
      }

      return h(
        'div',
        { className: 'mcpmp-card' },
        h(
          'div',
          { className: 'mcpmp-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'mcpmp-caret',
              'aria-expanded': expanded,
              'aria-label': expanded ? t('collapse') : t('expand'),
              onClick: props.onExpand,
              style: { transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' },
            },
            h(Icon, { path: ICON_PATH.chevron, size: 13 }),
          ),
          h(
            'div',
            { className: 'mcpmp-avatar', style: { background: avatarColor(server.serverName) } },
            avatarLetter(server.serverName),
          ),
          h(
            'div',
            { className: 'mcpmp-grow' },
            h(
              'div',
              { className: 'mcpmp-name' },
              h('span', { title: server.serverName }, server.displayName || server.serverName),
              server.enabled ? h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, '✓') : null,
            ),
            h(
              'div',
              { className: 'mcpmp-meta' },
              h('span', { className: 'mcpmp-dot mcpmp-dot-' + phase }),
              h('span', null, phaseLabel),
              h('span', { className: 'mcpmp-tag' }, t('toolCount', { n: tools.length })),
              h('span', { className: 'mcpmp-tag' }, sourceLabel),
            ),
          ),
          actions.length > 0 ? h('div', { style: { display: 'flex', gap: 6 } }, actions) : null,
          h(Switch, {
            checked: server.enabled,
            disabled: busy || server.id === '',
            label: server.serverName,
            onChange: props.onToggle,
          }),
        ),
        expanded
          ? h(
              'div',
              { className: 'mcpmp-tools' },
              tools.length === 0
                ? h('div', { className: 'mcpmp-tools-empty' }, t('noTools'))
                : tools.map(function (tool) {
                    return h(
                      'div',
                      { className: 'mcpmp-tool', key: tool.fullName || tool.name },
                      h('code', { title: tool.fullName }, tool.name),
                      h('p', { title: tool.description }, tool.description),
                    );
                  }),
            )
          : null,
      );
    }

    /**
     * A two-option segmented control.
     *
     * Used for the edit dialog's mode switch. It is a radiogroup rather than
     * two buttons so the current mode is announced correctly, and so arrow keys
     * work the way a keyboard user expects.
     */
    /**
     * The clipboard formats this box accepts, grouped by the container key a
     * user actually sees in their other tool's file. Kept in step with the
     * parser in `lib/import.js`; `test/client.test.mjs` asserts they agree.
     */
    var FORMAT_ROWS = [
      {
        tools: 'Claude Code · Cursor · Windsurf · Qoder · Cherry Studio · CodeBuddy · TRAE · ZCode',
        key: 'mcpServers',
        note: null,
      },
      { tools: 'DeepSeek Harness', key: 'mcpServers', note: null },
      { tools: 'VS Code', key: 'servers', note: null },
      { tools: 'Codex', key: 'mcp_servers', note: 'TOML' },
      { tools: 'OpenCode', key: 'mcp', note: 'type: local / remote' },
      { tools: 'Continue', key: 'mcpServers', note: 'array' },
      { tools: 'Pi', key: 'mcpServers', note: 'settings ignored' },
    ];

    /**
     * A two-option segmented switch with a sliding indicator.
     *
     * Used for the edit dialog's mode switch. It is a radiogroup rather than
     * two buttons so the current mode is announced correctly and arrow keys
     * work as a keyboard user expects; the sliding pill is a separate element
     * (not a background on the active button) so it can animate between the two
     * without either option changing size.
     */
    function Segmented(props) {
      var index = props.options.findIndex(function (option) {
        return option.value === props.value;
      });
      if (index < 0) index = 0;
      return h(
        'div',
        {
          className: 'mcpmp-seg',
          role: 'radiogroup',
          'aria-label': props.label,
          'data-index': String(index),
          'data-count': String(props.options.length),
        },
        h('span', { className: 'mcpmp-seg-pill', 'aria-hidden': 'true' }),
        props.options.map(function (option) {
          var active = option.value === props.value;
          return h(
            'button',
            {
              key: option.value,
              type: 'button',
              role: 'radio',
              'aria-checked': active,
              tabIndex: active ? 0 : -1,
              className: 'mcpmp-seg-btn' + (active ? ' mcpmp-seg-on' : ''),
              onClick: function () {
                props.onChange(option.value);
              },
              // Arrow keys move between the two options, as a radiogroup does.
              onKeyDown: function (event) {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                var step = event.key === 'ArrowRight' ? 1 : -1;
                var next = (index + step + props.options.length) % props.options.length;
                props.onChange(props.options[next].value);
              },
            },
            option.icon === undefined ? null : h(Icon, { path: option.icon, size: 13 }),
            h('span', null, option.label),
          );
        }),
      );
    }

    /** A modal shell with a title, a body and a footer. */
    function Modal(props) {
      var onClose = props.onClose;
      useEffect(
        function () {
          function onKey(event) {
            if (event.key === 'Escape') onClose();
          }
          document.addEventListener('keydown', onKey);
          return function () {
            document.removeEventListener('keydown', onKey);
          };
        },
        [onClose],
      );
      return h(
        'div',
        {
          className: 'mcpmp-overlay',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'mcpmp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
          h(
            'div',
            { className: 'mcpmp-modal-head' },
            h('h3', null, props.title),
            // Optional control between the title and the close button (the
            // edit dialog puts its form/JSON switch here).
            props.headerExtra !== undefined ? props.headerExtra : null,
            h(
              'button',
              {
                type: 'button',
                className: 'mcpmp-btn mcpmp-btn-sm mcpmp-icon',
                onClick: onClose,
                'aria-label': props.closeLabel,
              },
              h(Icon, { path: ICON_PATH.close, size: 13 }),
            ),
          ),
          h('div', { className: 'mcpmp-modal-body' }, props.children),
          h('div', { className: 'mcpmp-modal-foot' }, props.footer),
        ),
      );
    }

    /**
     * Which tools' configurations this box accepts, and the one thing a user
     * needs to know about each: the container key differs, so a paste that
     * "looks wrong" usually is not.
     *
     * Rendered as a compact grid rather than a paragraph because the useful
     * information is per-tool, and a wall of names is what makes people give up
     * and hand-edit the JSON instead.
     */
    function FormatHint(props) {
      var t = props.t;
      return h(
        'details',
        { className: 'mcpmp-formats' },
        h(
          'summary',
          null,
          h(Icon, { path: ICON_PATH.chevron, size: 12 }),
          t('formatsSummary'),
        ),
        h(
          'div',
          { className: 'mcpmp-formats-grid' },
          FORMAT_ROWS.map(function (row) {
            return h(
              'div',
              { className: 'mcpmp-format', key: row.tools },
              h('span', { className: 'mcpmp-format-tools' }, row.tools),
              h('code', null, row.key),
              row.note === null ? null : h('em', null, row.note),
            );
          }),
        ),
        h('p', { className: 'mcpmp-formats-foot' }, t('formatsFooter')),
      );
    }

    /** The paste-a-configuration dialog. */
    /**
     * The raw-JSON dialog, used both to add servers and to edit one.
     *
     * Editing passes `server`, which seeds the box with that server's own
     * configuration and makes the submit an in-place update: the row keeps its
     * id and its overrides, and renaming inside the JSON renames the row rather
     * than leaving a stray copy behind.
     */
    function ManualConfigDialog(props) {
      var t = props.t;
      var editing = props.server !== null && props.server !== undefined;
      var [text, setText] = useState(function () {
        return editing ? serverToJson(props.server) : '';
      });
      var [error, setError] = useState(null);
      var [busy, setBusy] = useState(false);

      function submit() {
        if (busy) return;
        if (text.trim() === '') {
          setError(t('manualHint'));
          return;
        }
        setBusy(true);
        setError(null);
        api('import', {
          json: text,
          originalName: editing ? props.server.serverName : undefined,
        })
          .then(function (result) {
            setBusy(false);
            props.onDone(result);
          })
          .catch(function (failure) {
            setBusy(false);
            setError(String((failure && failure.message) || failure));
          });
      }

      return h(
        Modal,
        {
          title: editing ? t('editJsonTitle') : t('manualTitle'),
          closeLabel: t('close'),
          onClose: props.onClose,
          // The mirror of the form dialog's switch, so the two modes are
          // reachable from each other rather than one-way.
          headerExtra: editing
            ? h(Segmented, {
                label: t('modeLabel'),
                value: 'json',
                options: [
                  { value: 'form', label: t('modeForm'), icon: ICON_PATH.form },
                  { value: 'json', label: t('modeJson'), icon: ICON_PATH.code },
                ],
                onChange: function (mode) {
                  if (mode === 'form') props.onSwitchToForm();
                },
              })
            : undefined,
          footer: h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                gap: 12,
              },
            },
            h('span', { className: 'mcpmp-note-warn', style: { fontSize: 12 } }, '⚠ ' + t('manualWarn')),
            h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              h('button', { type: 'button', className: 'mcpmp-btn', onClick: props.onClose }, t('cancel')),
              h(
                'button',
                { type: 'button', className: 'mcpmp-btn mcpmp-btn-primary', disabled: busy, onClick: submit },
                busy ? t('saving') : t('confirm'),
              ),
            ),
          ),
        },
        h('p', null, editing ? t('editJsonHint') : t('manualHint')),
        h(FormatHint, { t: t }),
        h('textarea', {
          className: 'mcpmp-textarea',
          rows: 12,
          spellCheck: false,
          'aria-label': editing ? t('editJsonTitle') : t('manualTitle'),
          value: text,
          placeholder: t('manualPlaceholder'),
          onChange: function (event) {
            setText(event.target.value);
          },
        }),
        error !== null ? h('div', { className: 'mcpmp-note mcpmp-note-error' }, error) : null,
      );
    }

    /** The add/edit form for one server. */
    function ServerFormDialog(props) {
      var t = props.t;
      var editing = props.server !== null && props.server !== undefined;
      var server = props.server || {};
      var [form, setForm] = useState(function () {
        return {
          serverName: server.serverName || '',
          transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
          command: server.command || '',
          args: (server.args || []).join('\n'),
          env: mapToLines(server.env),
          cwd: server.cwd || '',
          url: server.url || '',
          headers: mapToLines(server.headers),
        };
      });
      var [error, setError] = useState(null);
      var [busy, setBusy] = useState(false);

      function field(key) {
        return function (event) {
          var value = event.target.value;
          setForm(function (previous) {
            var next = Object.assign({}, previous);
            next[key] = value;
            return next;
          });
        };
      }

      function submit() {
        if (busy) return;
        setBusy(true);
        setError(null);
        var http = form.transport === 'streamable-http';
        // `originalName` is sent only for an edit: it is what distinguishes
        // updating an existing row from creating one, and an accidental value
        // on a create would be rejected as an unknown server.
        api('save', {
          serverName: form.serverName,
          originalName: editing ? server.serverName : undefined,
          transport: form.transport,
          command: http ? '' : form.command,
          args: http ? [] : linesToArray(form.args),
          env: http ? {} : linesToMap(form.env),
          cwd: http ? '' : form.cwd,
          url: http ? form.url : '',
          headers: http ? linesToMap(form.headers) : {},
        })
          .then(function (result) {
            setBusy(false);
            props.onDone(result);
          })
          .catch(function (failure) {
            setBusy(false);
            setError(String((failure && failure.message) || failure));
          });
      }

      function textField(key, label, hint, extra) {
        return h(
          'div',
          { className: 'mcpmp-field' },
          h('label', null, label),
          h(
            'input',
            Object.assign(
              {
                className: 'mcpmp-input',
                value: form[key],
                onChange: field(key),
                spellCheck: false,
                'aria-label': label,
              },
              extra || {},
            ),
          ),
          hint ? h('small', null, hint) : null,
        );
      }

      function areaField(key, label, hint) {
        return h(
          'div',
          { className: 'mcpmp-field' },
          h('label', null, label),
          h('textarea', {
            className: 'mcpmp-textarea',
            rows: 4,
            spellCheck: false,
            'aria-label': label,
            value: form[key],
            onChange: field(key),
          }),
          hint ? h('small', null, hint) : null,
        );
      }

      var http = form.transport === 'streamable-http';
      return h(
        Modal,
        {
          title: editing ? t('editTitle') : t('addTitle'),
          closeLabel: t('close'),
          onClose: props.onClose,
          // Only an existing server can be reopened as JSON: the JSON editor
          // updates one named row, so it needs a row to name.
          headerExtra: editing
            ? h(Segmented, {
                label: t('modeLabel'),
                value: 'form',
                options: [
                  { value: 'form', label: t('modeForm'), icon: ICON_PATH.form },
                  { value: 'json', label: t('modeJson'), icon: ICON_PATH.code },
                ],
                onChange: function (mode) {
                  if (mode === 'json') props.onSwitchToJson();
                },
              })
            : undefined,
          footer: h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, width: '100%' } },
            h('button', { type: 'button', className: 'mcpmp-btn', onClick: props.onClose }, t('cancel')),
            h(
              'button',
              { type: 'button', className: 'mcpmp-btn mcpmp-btn-primary', disabled: busy, onClick: submit },
              busy ? t('saving') : t('confirm'),
            ),
          ),
        },
        h(
          'div',
          { className: 'mcpmp-field' },
          h('label', null, t('name')),
          h('input', {
            className: 'mcpmp-input',
            value: form.serverName,
            spellCheck: false,
            disabled: editing,
            'aria-label': t('name'),
            onChange: field('serverName'),
            placeholder: 'my-server',
          }),
          h('small', null, t('nameHint')),
        ),
        h(
          'div',
          { className: 'mcpmp-field' },
          h('label', null, t('transport')),
          h(
            'select',
            {
              className: 'mcpmp-select',
              value: form.transport,
              'aria-label': t('transport'),
              onChange: field('transport'),
            },
            h('option', { value: 'stdio' }, t('transportStdio')),
            h('option', { value: 'streamable-http' }, t('transportHttp')),
          ),
        ),
        http
          ? h(
              react.Fragment,
              null,
              textField('url', t('url'), t('urlHint'), { placeholder: 'http://localhost:3000/mcp' }),
              areaField('headers', t('headers'), t('headersHint')),
            )
          : h(
              react.Fragment,
              null,
              textField('command', t('command'), t('commandHint'), { placeholder: 'npx' }),
              areaField('args', t('args'), t('argsHint')),
              areaField('env', t('env'), t('envHint')),
              textField('cwd', t('cwd'), t('cwdHint')),
            ),
        error !== null ? h('div', { className: 'mcpmp-note mcpmp-note-error' }, error) : null,
      );
    }

    /**
     * Language preference plumbing.
     *
     * The page supports three modes: "auto" (follow the harness locale, falling
     * back to the browser's language when the locale service is unreachable)
     * or a pinned language. The choice persists in localStorage so it survives
     * reloads. `localeRef.current` always holds the EFFECTIVE language; the
     * nav-row watcher and every API call read it.
     */
    var LANG_KEY = 'dsh-mcp-manager-plus:lang';
    var LANG_MODES = ['auto', 'zh', 'en'];

    /** The persisted preference, defaulting to "auto". */
    function readLangPref() {
      try {
        var stored = localStorage.getItem(LANG_KEY);
        return LANG_MODES.indexOf(stored) !== -1 ? stored : 'auto';
      } catch (error) {
        return 'auto';
      }
    }

    /** Persist a preference; a failing store only loses persistence. */
    function writeLangPref(mode) {
      try {
        localStorage.setItem(LANG_KEY, mode);
      } catch (error) {
        // ignore — the switch itself still works for this session
      }
    }

    /** The browser's own language, used when the locale service is absent. */
    function browserLocale() {
      try {
        var languages = navigator.languages || [navigator.language];
        for (var i = 0; i < languages.length; i += 1) {
          var code = typeof languages[i] === 'string' ? languages[i].slice(0, 2).toLowerCase() : '';
          if (code === 'zh') return 'zh';
          if (code === 'en') return 'en';
        }
      } catch (error) {
        // fall through
      }
      return 'zh';
    }

    var langPrefRef = { current: readLangPref() };
    /**
     * The harness locale as reported by the locale service, when reachable —
     * the resolution of "auto" prefers it over the browser guess.
     */
    var shellLocaleRef = { current: null };
    var localeRef = {
      current: langPrefRef.current === 'auto' ? browserLocale() : langPrefRef.current,
    };

    /** The settings page itself. */
    function McpManagerPage() {
      // locale drives re-renders; localeRef mirrors it for non-React readers
      // (nav-row matching, api()).
      var [locale, setLocaleState] = useState(localeRef.current);
      var t = makeT(locale);
      var [state, setState] = useState({ status: 'loading', data: null, error: null });
      var [busyId, setBusyId] = useState(null);
      var [expanded, setExpanded] = useState({});
      var [dialog, setDialog] = useState(null);
      var [notice, setNotice] = useState(null);
      var settleTimer = useRef(null);
      var pageRef = useRef(null);

      // Swap this page's settings nav-row icon. watchNavRow already keeps the
      // row flagged from registration time, so this is only a fallback for
      // environments where the observer is unavailable.
      useEffect(function () {
        return markNavRow(pageRef.current);
      }, []);

      /** Fetch the inventory, optionally keeping the current view while it loads. */
      var load = useCallback(function (quiet) {
        if (!quiet) setState({ status: 'loading', data: null, error: null });
        return api('servers')
          .then(function (data) {
            setState({ status: 'ready', data: data, error: null });
            return data;
          })
          .catch(function (failure) {
            setState({ status: 'error', data: null, error: String((failure && failure.message) || failure) });
          });
      }, []);

      useEffect(
        function () {
          load(false);
          return function () {
            if (settleTimer.current !== null) clearTimeout(settleTimer.current);
          };
        },
        [load],
      );

      /**
       * After a write, the loader converges on its own schedule (the profile's
       * file watcher), so poll a few times rather than reporting a tool list
       * that is still one generation stale.
       */
      function settle() {
        if (settleTimer.current !== null) clearTimeout(settleTimer.current);
        var attempts = 0;
        function tick() {
          attempts += 1;
          load(true).then(function () {
            if (attempts < 5) settleTimer.current = setTimeout(tick, 450);
            else settleTimer.current = null;
          });
        }
        settleTimer.current = setTimeout(tick, 350);
      }

      /**
       * Switch the page language. "auto" resolves to the harness locale when
       * the locale service reported one, else the browser's language. The
       * choice persists and re-renders the whole page; api() picks the change
       * up for host-side messages on the next request.
       */
      function setLang(mode) {
        writeLangPref(mode);
        langPrefRef.current = mode;
        var next =
          mode === 'auto'
            ? shellLocaleRef.current !== null
              ? shellLocaleRef.current
              : browserLocale()
            : mode;
        localeRef.current = next;
        setLocaleState(next);
      }

      /** Run one mutation, folding the returned state back into the page. */
      function run(id, promise, successMessage) {
        setBusyId(id);
        return promise
          .then(function (result) {
            setBusyId(null);
            if (result && result.state) setState({ status: 'ready', data: result.state, error: null });
            if (successMessage !== undefined) setNotice(successMessage);
            settle();
            return result;
          })
          .catch(function (failure) {
            setBusyId(null);
            setNotice(String((failure && failure.message) || failure));
            return null;
          });
      }

      var data = state.data;
      var servers = data !== null && Array.isArray(data.servers) ? data.servers : [];
      var issues = data !== null && Array.isArray(data.issues) ? data.issues : [];
      var readOnly = data !== null && data.writable === false;

      var transfer = null;
      if (state.status === 'loading') {
        transfer = h('div', { className: 'mcpmp-note' }, t('loading'));
      } else if (state.status === 'error') {
        transfer = h(
          'div',
          { className: 'mcpmp-note mcpmp-note-error' },
          t('loadFailed') + '：' + state.error,
          ' ',
          h(
            'button',
            {
              type: 'button',
              className: 'mcpmp-btn mcpmp-btn-sm',
              onClick: function () {
                load(false);
              },
            },
            t('retry'),
          ),
        );
      } else if (servers.length === 0) {
        transfer = h(
          'div',
          { className: 'mcpmp-note' },
          h('div', null, t('empty')),
          h('div', { style: { marginTop: 2 } }, t('emptyHint')),
        );
      } else {
        transfer = h(
          'div',
          { className: 'mcpmp-list' },
          servers.map(function (server) {
            return h(ServerCard, {
              key: server.id + ':' + server.serverName,
              t: t,
              server: server,
              busy: busyId === server.id,
              expanded: expanded[server.serverName] === true,
              onExpand: function () {
                setExpanded(function (previous) {
                  var next = Object.assign({}, previous);
                  next[server.serverName] = !(previous[server.serverName] === true);
                  return next;
                });
              },
              onToggle: function () {
                run(server.id, api('toggle', { id: server.id, enabled: !server.enabled, source: server.source }));
              },
              onRestart: function () {
                run(server.id, api('restart', { id: server.id }), t('restartDone', { name: server.serverName }));
              },
              onRemove: function () {
                if (!window.confirm(t('removeConfirm', { name: server.serverName }))) return;
                run(server.id, api('remove', { id: server.id }), t('removed') + '：' + server.serverName);
              },
              onEdit: function () {
                setDialog({ kind: 'form', server: server });
              },
            });
          }),
        );
      }

      return h(
        'div',
        { className: 'mcpmp-root', ref: pageRef },
        h(
          'div',
          { className: 'mcpmp-head' },
          h('div', null, h('h2', null, t('title')), h('p', null, t('description'))),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h(
              'label',
              { className: 'mcpmp-lang', title: t('langLabel') },
              h('span', { className: 'mcpmp-lang-glyph', 'aria-hidden': 'true' }, '文A'),
              h(
                'select',
                {
                  value: langPrefRef.current,
                  onChange: function (event) {
                    setLang(event.target.value);
                  },
                  'aria-label': t('langLabel'),
                },
                h('option', { value: 'auto' }, t('langAuto')),
                h('option', { value: 'zh' }, '中文'),
                h('option', { value: 'en' }, 'English'),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mcpmp-btn mcpmp-btn-sm mcpmp-icon',
                title: t('refresh'),
                'aria-label': t('refresh'),
                disabled: state.status === 'loading',
                onClick: function () {
                  api('refresh', {}).then(function (next) {
                    setState({ status: 'ready', data: next, error: null });
                  });
                },
              },
              h(Icon, { path: ICON_PATH.refresh, size: 14 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mcpmp-btn mcpmp-btn-primary',
                disabled: readOnly,
                onClick: function () {
                  setDialog({ kind: 'manual' });
                },
              },
              h(Icon, { path: ICON_PATH.plus, size: 13 }),
              t('add'),
            ),
          ),
        ),

        readOnly
          ? h('div', { className: 'mcpmp-note mcpmp-note-warn' }, t('notWritable', { path: data.patchPath }))
          : null,

        issues.length > 0
          ? h(
              'div',
              { className: 'mcpmp-note mcpmp-note-warn' },
              h('div', { style: { fontWeight: 500, marginBottom: 4 } }, t('issues')),
              issues.map(function (issue, index) {
                return h('div', { key: index }, '• ' + issue);
              }),
            )
          : null,

        notice !== null
          ? h(
              'div',
              {
                className: 'mcpmp-note',
                style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' },
              },
              h('span', null, notice),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mcpmp-btn mcpmp-btn-sm',
                  onClick: function () {
                    setNotice(null);
                  },
                },
                t('close'),
              ),
            )
          : null,

        transfer,

        dialog !== null && dialog.kind === 'manual'
          ? h(ManualConfigDialog, {
              t: t,
              server: dialog.server,
              onClose: function () {
                setDialog(null);
              },
              onDone: function (result) {
                setDialog(null);
                setNotice(t('imported') + '：' + (result.message || ''));
                settle();
              },
              // Switching back keeps the same server, so the form reopens
              // seeded from the row as it is on disk rather than from whatever
              // was half-typed in the JSON box.
              onSwitchToForm: dialog.server
                ? function () {
                    var server = dialog.server;
                    setDialog({ kind: 'form', server: server });
                  }
                : undefined,
            })
          : null,

        dialog !== null && dialog.kind === 'form'
          ? h(ServerFormDialog, {
              t: t,
              server: dialog.server,
              onClose: function () {
                setDialog(null);
              },
              onDone: function (result) {
                setDialog(null);
                if (result && result.state) setState({ status: 'ready', data: result.state, error: null });
                setNotice(t('saved') + '：' + (result.serverName || ''));
                settle();
              },
              onSwitchToJson: dialog.server
                ? function () {
                    var server = dialog.server;
                    setDialog({ kind: 'manual', server: server });
                  }
                : undefined,
            })
          : null,
      );
    }

    exports.name = 'dsh-mcp-manager-plus';
    // `slots` must be DECLARED, not merely looked up. A declared service is
    // resolved before apply() runs and parks the plugin until its provider
    // exists; `ctx.get('slots')` with an empty inject list resolves to
    // `undefined` even while the service is live, so the page would never
    // register. `locale` stays optional (ctx.get) because it is a
    // nice-to-have: the page falls back to its built-in dictionary.
    exports.inject = ['slots'];

    exports.apply = function apply(ctx) {
      installStyles();

      var locale = ctx.get('locale');
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(
          function () {
            return locale.register(NS, { zh: DICT.zh, en: DICT.en });
          },
          'dsh-mcp-manager-plus: dictionaries',
        );
        // Track the active locale so "auto" mode follows the UI language. A
        // pinned language ignores the harness locale entirely.
        try {
          var read = function () {
            var id = locale.getLocale().id === 'en' ? 'en' : 'zh';
            shellLocaleRef.current = id;
            if (langPrefRef.current === 'auto') localeRef.current = id;
          };
          read();
          ctx.effect(function () {
            return locale.subscribe(read);
          }, 'dsh-mcp-manager-plus: locale mirror');
        } catch (error) {
          console.warn('[dsh-mcp-manager-plus] locale mirror skipped:', error);
        }
      }

      // `slots` is declared in `inject`, so it is present by the time apply()
      // runs. A registration failure is reported by throwing: a settings page
      // that silently never appears is the one failure mode this plugin must
      // not have.
      var slots = ctx.slots;
      if (slots === undefined) {
        throw new Error(
          '[dsh-mcp-manager-plus] the slots service is unavailable, so the settings page cannot be registered',
        );
      }
      ctx.effect(function () {
        return slots.inject('settings.section', function () {
          return slots.register(
            {
              name: 'settings.section',
              id: 'mcp',
              order: 35,
              label: function () {
                return makeT(localeRef.current)('nav');
              },
            },
            McpManagerPage,
          );
        });
      }, 'dsh-mcp-manager-plus: settings section');

      // Flag the nav row from the moment the shell first renders it, so the
      // link icon shows before the page is ever opened.
      ctx.effect(watchNavRow, 'dsh-mcp-manager-plus: nav row icon watch');
    };

    return module.exports;
  },
});
