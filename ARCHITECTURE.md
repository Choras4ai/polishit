# 中文润色 — 项目架构文档

> 最后更新: 2026-04-10 v1.5.0
> 维护者: choras
> 本文档是项目的"唯一真相源"，后续所有模块修改必须同步更新本文档。

---

## 1. 产品概述

一款跨平台（macOS / Windows）桌面工具，核心流程：

```
选中文本 → 全局快捷键 → AI润色 → Grammarly风格内联标注 → 逐条审阅/一键替换
```

**核心原则**: 轻量、隐私优先、无侵入、用完即走、Grammarly 式交互体验。

---

## 2. 技术栈

| 层级         | 技术                 | 说明                          |
|-------------|---------------------|-------------------------------|
| 框架         | Electron 28+        | 跨平台桌面应用               |
| 前端         | 原生 HTML/CSS/JS    | 无框架依赖，启动快            |
| 持久化       | electron-store      | JSON 配置文件，存于用户目录   |
| AI 接口      | OpenAI / Anthropic / Ollama | 标准 HTTP 调用，支持多服务商预设 |
| 构建         | electron-builder    | 输出 .dmg / .exe              |

---

## 3. 目录结构与模块职责

```
APP-中文润色/
├── main.js                       # [M1] 主进程入口 & IPC 路由
├── preload.js                    # [M2] 安全桥接层
├── package.json                  # 项目配置 & 构建配置
├── ARCHITECTURE.md               # 本文档
│
├── assets/
│   ├── tray-icon.png             # 托盘图标
│   ├── tray-iconTemplate.png     # macOS 模板图标
│   └── tray-iconTemplate@2x.png  # Retina 模板图标
│
└── src/
    ├── config.js                 # [M3] 配置管理
    ├── capture.js                # [M4] 文本捕获 & 粘贴
    ├── shortcuts.js              # [M5] 全局快捷键管理
    ├── windows.js                # [M6] 窗口管理
    ├── tray.js                   # [M7] 系统托盘
    ├── diff.js                   # [M8] Diff引擎
    │
    ├── ai/
    │   ├── base-provider.js      # [M9] AI Provider 抽象基类
    │   ├── openai-provider.js    # [M10] OpenAI 兼容接口实现
    │   ├── ollama-provider.js    # [M11] Ollama 本地模型实现
    │   ├── anthropic-provider.js # [M12] Anthropic/Claude 实现
    │   ├── provider-factory.js   # [M13] Provider 工厂（含预设解析）
    │   ├── presets.js            # [M14] 服务商预设配置
    │   ├── builtin-key.js        # [M15] 内置体验 Key（XOR 混淆）
    │   └── pipeline.js           # [M16] 多智能体处理管线
    │
    └── renderer/
        ├── result/
        │   ├── index.html        # [M17] 结果窗口 HTML
        │   ├── style.css         # [M17] 结果窗口样式
        │   └── script.js         # [M17] 结果窗口逻辑
        │
        ├── settings/
        │   ├── index.html        # [M18] 设置窗口 HTML
        │   ├── style.css         # [M18] 设置窗口样式
        │   └── script.js         # [M18] 设置窗口逻辑
        │
        └── onboarding/
            ├── index.html        # [M19] 新手引导 HTML
            ├── style.css         # [M19] 新手引导样式
            └── script.js         # [M19] 新手引导逻辑
```

---

## 4. 模块详细说明

### M1 — 主进程入口 (`main.js`)

**职责**: 应用生命周期管理、模块编排、IPC 路由分发。

**关键逻辑**:
- 单实例锁 (`requestSingleInstanceLock`)
- 隐藏 Dock 图标，仅驻留托盘
- `handleTrigger()` 是核心触发函数：捕获文本 → 创建 Provider → 执行 Pipeline → 发送结果
- `registerIPC()` 注册所有 renderer→main 的通信通道

**IPC 通道清单**:

| 通道                   | 方向           | 说明                    |
|-----------------------|---------------|------------------------|
| `config:get`          | renderer→main | 获取全部配置             |
| `config:set`          | renderer→main | 设置单个配置项           |
| `action:replace`      | renderer→main | 关闭窗口并粘贴替换文本   |
| `action:copy`         | renderer→main | 复制文本到剪贴板         |
| `window:open-settings`| renderer→main | 打开设置窗口             |
| `window:close-result` | renderer→main | 关闭结果窗口             |
| `shortcut:get`        | renderer→main | 获取当前快捷键           |
| `shortcut:set`        | renderer→main | 更新快捷键               |
| `ai:test-connection`  | renderer→main | 测试 AI 连接             |
| `presets:get`         | renderer→main | 获取服务商预设列表        |
| `onboarding:complete` | renderer→main | 完成引导并保存预设选择    |
| `window:open-onboarding`| renderer→main | 打开新手引导窗口        |
| `polish:original`     | main→renderer | 发送原始文本给结果窗口   |
| `polish:result`       | main→renderer | 发送润色结果给结果窗口   |
| `polish:error`        | main→renderer | 发送错误信息给结果窗口   |
| `polish:progress`     | main→renderer | 发送进度更新给结果窗口   |

**修改指南**:
- 新增 IPC 通道：同时更新 `main.js`、`preload.js`、对应 renderer `script.js`
- 新增模块：在 `app.whenReady()` 中初始化

---

### M2 — 安全桥接层 (`preload.js`)

**职责**: 通过 `contextBridge` 暴露安全 API 给 renderer，隔离 Node.js 上下文。

**暴露的 API 命名空间**: `window.polishAPI`

**安全约束**:
- `contextIsolation: true` — 渲染进程无法直接访问 Node.js
- `nodeIntegration: false` — 禁止渲染进程使用 require
- `sandbox: true` — 沙箱模式
- 仅白名单通道可通信

**修改指南**:
- 新增 API 方法：在 `polishAPI` 对象中添加，遵循现有的 `ipcRenderer.invoke` 模式
- 事件监听：使用 `on()` 辅助函数包装，返回 unsubscribe 方法

---

### M3 — 配置管理 (`src/config.js`)

**职责**: 统一管理应用配置的读写与默认值。

**存储位置**: `~/Library/Application Support/chinese-text-polish/chinese-polish-config.json`

**配置结构**:
```json
{
  "provider": {
    "preset": "together | deepseek | doubao | gemini | claude | openai | ollama | custom",
    "apiUrl": "",
    "apiKey": "",
    "model": ""
  },
  "shortcut": "CommandOrControl+Shift+A",
  "pipeline": {
    "mode": "single | multi",
    "temperature": 0.3
  },
  "ui": {
    "theme": "system"
  },
  "onboarding": {
    "completed": true
  }
}
```

**预设服务商**:

| ID        | 名称              | providerType | 需要 Key | 说明                    |
|-----------|-------------------|-------------|---------|------------------------|
| together  | Together AI        | openai      | ✗       | 内置免费体验 Key         |
| deepseek  | DeepSeek           | openai      | ✓       | 国产，性价比高           |
| doubao    | 豆包（字节跳动）    | openai      | ✓       | 火山引擎 API            |
| gemini    | Google Gemini      | openai      | ✓       | OpenAI 兼容端点         |
| claude    | Claude (Anthropic) | anthropic   | ✓       | 原生 Anthropic API      |
| openai    | OpenAI             | openai      | ✓       | GPT-4o 等              |
| ollama    | Ollama 本地模型     | ollama      | ✗       | 完全离线               |
| custom    | 自定义接口          | openai      | ✓       | 手动填写               |

**修改指南**:
- 新增配置项：在 `DEFAULTS` 中添加默认值
- 配置迁移：如果修改了已有配置结构，需在 `constructor` 中处理旧数据兼容

---

### M4 — 文本捕获与粘贴 (`src/capture.js`)

**职责**: 模拟系统快捷键实现文本获取与粘贴，并跟踪原始应用焦点。

**v1.2.0 新增**: 前台应用记忆 — `saveFrontApp()` / `restoreFrontApp()`

**捕获流程**:
1. `saveFrontApp()` 记录当前前台应用的 bundle identifier
2. 保存剪贴板内容
3. 写入哨兵值（sentinel）
4. 通过 AppleScript 模拟 `Cmd+C`
5. 等待 250ms 后读取剪贴板
6. 若内容 ≠ 哨兵值 → 捕获成功
7. 异步恢复原始剪贴板内容

**替换流程** (`pasteText`):
1. 将替换文本写入剪贴板
2. `restoreFrontApp()` 通过 AppleScript 重新激活原始应用
3. 等待 300ms 确保窗口切换完成
4. 模拟 `Cmd+V` 粘贴

**平台支持**:
- macOS: AppleScript (`osascript`)
- Windows: 预留 `throw Error`

**注意事项**:
- 需要「辅助功能」权限（System Preferences → Privacy → Accessibility）
- 首次运行需引导用户授权

---

### M5 — 快捷键管理 (`src/shortcuts.js`)

**职责**: 注册/注销全局快捷键。

**关键行为**:
- `register()`: 先注销旧快捷键，再注册新的
- 失败时仅 console.error，不阻断应用
- 使用 Electron `globalShortcut` API

**修改指南**:
- 多快捷键支持：将 `currentAccelerator` 改为数组
- 冲突检测：注册前可以用 `globalShortcut.isRegistered()` 检查

---

### M6 — 窗口管理 (`src/windows.js`)

**职责**: 创建和管理结果窗口、设置窗口、新手引导窗口。

**v1.2.0 更新**: `showResult()` 改为 `async`，等待 `did-finish-load` 后才返回

**结果窗口特性**:
- 400×500，跟随鼠标光标弹出（Grammarly 风格定位）
- 自动适应屏幕边界（不溢出 workArea）
- `frame: false` 无边框（自定义标题栏）
- `alwaysOnTop: true` 始终置顶
- `vibrancy: 'under-window'` macOS 毛玻璃效果
- Esc 关闭
- **关键修复**: `await did-finish-load` 解决 IPC 消息丢失问题

**设置窗口特性**:
- 520×580，不可缩放
- `titleBarStyle: 'hiddenInset'` 原生标题栏按钮
- 毛玻璃效果

**修改指南**:
- 新增窗口类型：参照现有模式添加新方法
- 窗口尺寸调整：修改对应的 `width`/`height`
- 跨窗口通信：通过 `sendToResult()` 或新建类似方法

---

### M7 — 系统托盘 (`src/tray.js`)

**职责**: 创建托盘图标和右键菜单。

**菜单项**:
1. 显示当前快捷键（禁用状态，仅展示）
2. 设置…
3. 退出

**修改指南**:
- 自定义图标：替换 `nativeImage.createEmpty()` 为实际图标文件 (推荐 16x16 PNG)
- 新增菜单项：在 `Menu.buildFromTemplate()` 数组中添加

---

### M8 — Diff 引擎 (`src/diff.js`)

**职责**: 计算原文与润色结果的字符级差异，输出结构化变更列表。

**算法**:
1. `_trimCommon()` — 剥离公共前缀和后缀，缩小计算范围
2. `_lcsDiff()` — LCS (最长公共子序列) 动态规划
3. 大文本回退：当 `m*n > 9,000,000` 时退化为行级 diff
4. `_groupOps()` — 合并相邻同类操作
5. `_buildChanges()` — 构造最终变更对象（将相邻 delete+insert 合并为 replace）

**数据结构 — Change 对象**:
```js
// equal
{ id: 0, type: 'equal', text: '不变的文本' }

// replace
{ id: 1, type: 'replace', oldText: '原文', newText: '新文', status: 'pending' }

// delete
{ id: 2, type: 'delete', oldText: '被删除', status: 'pending' }

// insert
{ id: 3, type: 'insert', newText: '新插入', status: 'pending' }
```

**status 字段**: `'pending'` | `'accepted'` | `'rejected'`

**修改指南**:
- 优化算法：可替换为 Myers diff 或 patience diff
- 分词级 diff：将 `Array.from()` 替换为分词器输出
- 阈值调整：修改 `9_000_000` 常量

---

### M9 — AI Provider 基类 (`src/ai/base-provider.js`)

**职责**: 定义 AI 服务提供者的接口契约。

**必须实现的方法**:
- `async chat(messages, options)` → `string`
- `async testConnection()` → `boolean`

**修改指南**:
- 新增接口方法（如 stream）: 在基类中定义抽象方法

---

### M10 — OpenAI Provider (`src/ai/openai-provider.js`)

**职责**: 实现 OpenAI Chat Completions API 调用，兼容所有 OpenAI 格式接口（如 DeepSeek、通义千问等）。

**请求配置**:
- URL: `{apiUrl}/chat/completions`
- 超时: 60 秒 (`AbortSignal.timeout`)
- 认证: `Bearer {apiKey}`
- 使用全局 `fetch`（Electron 28+ 内置）

**修改指南**:
- 流式支持：添加 `chatStream()` 方法，处理 SSE
- 新模型参数：在 `body` 对象中添加
- 重试机制：包装 fetch 调用

---

### M11 — Ollama Provider (`src/ai/ollama-provider.js`)

**职责**: 调用本地 Ollama API。

**请求配置**:
- Chat URL: `{apiUrl}/api/chat`
- Test URL: `{apiUrl}/api/tags`
- `stream: false`（当前非流式）
- 超时: 120 秒（本地模型较慢）

**修改指南**:
- 模型列表：调用 `/api/tags` 获取可选模型
- 流式输出：设 `stream: true` 并逐行解析 NDJSON

---

### M12 — Anthropic Provider (`src/ai/anthropic-provider.js`)

**职责**: 调用 Anthropic Messages API（Claude 系列模型）。

**请求配置**:
- URL: `{apiUrl}/v1/messages`
- 认证: `x-api-key` header
- 需要 `anthropic-version: 2023-06-01` header
- system prompt 通过顶层 `system` 字段传递（非 messages 数组）
- 响应解析: `data.content[0].text`

---

### M13 — Provider 工厂 (`src/ai/provider-factory.js`)

**职责**: 根据配置创建对应 Provider 实例。解析预设 → 解析 providerType → 实例化。

**支持类型**: `openai` | `anthropic` | `ollama`

**内置 Key 逻辑**: 当 preset=`together` 且未填写 apiKey 时，自动调用 `getBuiltinKey()` 注入内置密钥。

---

### M14 — 服务商预设 (`src/ai/presets.js`)

**职责**: 定义所有预设 AI 服务商的配置参数。

**导出**: `PRESETS` 对象（id → preset）、`PRESET_ORDER` 数组（展示顺序）

---

### M15 — 内置 Key (`src/ai/builtin-key.js`)

**职责**: 存储和解码内置的 Together AI API Key。

**混淆方式**: XOR 编码 + Base64，运行时解码。
**安全说明**: 仅防止源码中明文暴露，不能防止逆向工程。生产环境应考虑使用后端代理。

---

### M16 — 多智能体管线 (`src/ai/pipeline.js`)

**职责**: 编排 AI 调用流程，支持单次/多步润色模式。

**v1.2.0 更新**: 全面升级为专业出版级 Prompt，新增错误类型分类。

**Prompt 设计原则**:
- 角色设定：拥有20年经验的资深编辑 / 语法审校专家 / 文学编辑
- 润色维度分级：硬伤修正 > 逻辑连贯 > 用词精准 > 句式优化 > 节奏韵律
- 严格约束：不添加信息、不改变语气、最小必要修改
- 修改说明返回错误类型：grammar / punctuation / wording / style / logic

**两种模式**:

| 模式     | 键值     | 流程                    | 特点                |
|---------|---------|------------------------|---------------------|
| 单次润色 | `single` | 专业全面润色（单次调用）   | 快速、成本低         |
| 多智能体 | `multi`  | 语法审校 → 风格优化       | 质量高、耗时翻倍     |

**完整处理流程**:
```
输入文本
  ↓
[单次模式] 直接润色             / [多智能体模式] 语法检查 → 风格优化
  ↓                            ↓
润色文本
  ↓
DiffEngine.compute(原文, 润色文本)    → diff 结果
  ↓
_explain(原文, 润色文本)              → 修改理由（JSON数组, best-effort）
  ↓
_mapExplanations(changes, explanations) → 将理由关联到每个 change
  ↓
返回 { polishedText, diff, explanations }
```

**Prompt 清单**:
- `singlePolish` — 单次全面润色
- `grammarCheck` — 仅语法/标点纠错
- `styleEnhance` — 风格优化
- `explain` — 对比分析修改理由

**修改指南**:
- 新增处理阶段：在 `_multiAgent()` 中追加步骤
- 自定义 Prompt：修改 `PROMPTS` 对象
- 新增模式：在 `process()` 中添加分支
- 进度回调：通过 `onProgress({ stage, percent })` 报告

---

### M17 — 结果窗口 (`src/renderer/result/`) — Grammarly 风格

**职责**: 以 Grammarly 风格展示润色建议，支持内联标注和弹出卡片。

**v1.2.0 重构**: 从传统 Diff 视图改为 Grammarly 式内联标注 + 弹出建议卡片。

**视图状态机**:
```
Loading ──[polish:result]──→ ResultView（有修改）
   ↓                          ↓
   │                    NoChangeView（无修改）
   ↓
 [polish:error] ──→ ErrorView
```

**内联标注交互**（类 Grammarly）:
- 原文全文展示，修改处以彩色波浪/虚线下划线标注
- 下划线颜色按错误类型区分：
  - 红色波浪线 → 语法问题 (grammar)
  - 蓝色虚线 → 标点符号 (punctuation)
  - 黄色波浪线 → 用词优化 (wording)
  - 蓝色实线 → 风格改善 (style)
  - 红色双下划线 → 逻辑修正 (logic)
  - 绿色波浪线 → 默认/其他
- 点击标注文字弹出建议卡片（Grammarly Popup Card 风格）

**弹出建议卡片** (`.popup-card`):
- 显示错误类型标签
- 显示 ~~原文~~ → **建议文本**（点击建议即接受）
- 显示修改理由
- 「接受修改」/ 「忽略」按钮
- 动画弹出，自动定位在标注文字下方

**底部操作栏**:
- 「全部忽略」— 所有修改标记 rejected
- 「全部接受」— 所有修改标记 accepted
- 「替换原文」— 接受所有 pending，关闭窗口，切回原应用并粘贴

**样式特性**:
- 支持 light/dark mode (`prefers-color-scheme`)
- macOS vibrancy 毛玻璃背景
- 品牌色 #4A7C6B（墨绿色）
- PingFang SC 字体优先
- 自定义滚动条

**修改指南**:
- 修改下划线样式：编辑 `style.css` 中 `.change-mark[data-error-type]`
- 修改弹出卡片：编辑 `.popup-card` 相关样式
- 新增操作按钮：在 `index.html` 的 `action-bar` 中添加
- 修改交互逻辑：编辑 `script.js` 中的对应事件 handler

---

### M18 — 设置窗口 (`src/renderer/settings/`)

**职责**: 提供配置管理界面。

**Tab 页结构**:

| Tab    | 内容                                              |
|--------|--------------------------------------------------|
| API 配置 | 服务商预设下拉选择、API Key 输入、高级选项（接口/模型）、测试连接 |
| 快捷键  | 当前快捷键展示、键盘录制新快捷键、保存              |
| 通用    | 浮窗开关、默认任务模式、处理模式、Temperature        |
| 提示词  | 三种模式的自定义额外提示词                           |
| 关于    | 版本号、功能介绍、作者信息                          |

**快捷键录制机制**:
- 聚焦 capture 区域后监听 `keydown`
- 要求至少包含一个修饰键（⌘/⌃/⌥）
- 格式化为 Electron accelerator 格式（如 `CommandOrControl+Shift+A`）
- 保存时实时更新全局快捷键注册

**修改指南**:
- 新增 Tab：在 HTML 添加 tab 按钮和 panel，在 JS 中添加保存逻辑
- 新增表单字段：在对应 panel 中添加 HTML，在 `loadConfig()` 和保存 handler 中添加读写

---

### M19 — 新手引导 (`src/renderer/onboarding/`)

**职责**: 首次启动时引导用户完成基本配置。

**流程**: 3 步向导
1. **欢迎页** — 功能介绍 + 两个入口：「立即体验」(Together AI 内置) / 「自行配置」
2. **选择服务商** — 显示所有预设供选择，需要 Key 的预设显示输入框
3. **准备就绪** — 展示快捷键 ⌘⇧A，提示辅助功能权限

**触发条件**: `config.onboarding.completed === false`（首次启动）

---

## 5. 数据流图

### 5.1 触发到结果的完整流程

```
用户在任意APP选中文本
        │
        ▼
  [全局快捷键触发] ─── ShortcutManager.register()
        │
        ▼
  handleTrigger() ── main.js
        │
        ├─ captureSelectedText()          ← M4
        │     └─ AppleScript Cmd+C → 读取剪贴板
        │
        ├─ windowManager.showResult()     ← M6
        │     └─ 创建结果窗口 → 显示 Loading
        │
        ├─ createProvider(config)          ← M13
        │     └─ 根据 preset 解析 providerType，实例化 Provider
        │
        ├─ pipeline.process(text)          ← M13
        │     ├─ Provider.chat()           ← M10/M11
        │     ├─ DiffEngine.compute()      ← M8
        │     └─ _explain() + _mapExplanations()
        │
        └─ sendToResult('polish:result')
              └─ 渲染 Diff 视图           ← M17
```

### 5.2 用户确认替换流程

```
用户点击「替换原文」
        │
        ▼
  computeFinalText()     ← M17 script.js
        │
        ▼
  IPC: action:replace    ← preload → main
        │
        ├─ hideResult()             关闭结果窗口
        ├─ wait 300ms               等待焦点还原
        └─ pasteText(text)          ← M4
              └─ 写入剪贴板 → AppleScript Cmd+V
```

---

## 6. 安全模型

| 层面         | 措施                                                 |
|-------------|-----------------------------------------------------|
| 进程隔离     | `contextIsolation: true`, `sandbox: true`           |
| Node.js 隔离 | `nodeIntegration: false`                            |
| API 安全     | 白名单 IPC 通道，preload 仅暴露约定方法              |
| CSP 策略     | `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'` |
| 数据隐私     | 无后端、无埋点、配置仅存本地、不存储历史记录          |
| 剪贴板保护   | 捕获后异步恢复原始剪贴板内容                         |
| API Key 存储 | 加密存储于 electron-store（依赖 OS keychain）        |

---

## 7. 构建与运行

```bash
# 安装依赖
npm install

# 开发模式运行
npm run dev

# 生产构建 (macOS .dmg)
npm run build:mac
```

**首次运行需授权**:
- System Preferences → Privacy & Security → Accessibility → 添加本应用

---

## 8. 扩展路线图（TODO）

以下为已规划但尚未实现的功能，按优先级排列：

### P0 — 必要优化
- [ ] 托盘图标：替换为正式 16x16 PNG 图标
- [ ] 应用签名：配置 Apple Developer 证书
- [ ] 错误边界：capture 失败时的友好引导（辅助功能权限检测）

### P1 — 体验增强
- [ ] 流式输出：AI 返回结果实时显示，减少等待感
- [ ] 动画过渡：Loading → Result 切换动画
- [ ] 历史记录：可选开启，记录最近 N 次润色
- [ ] 窗口位置记忆：记住上次窗口位置

### P2 — 功能扩展
- [ ] 自定义 Prompt：用户可编辑/添加润色风格模板
- [ ] 多模型对比：同时调用两个模型，取优
- [ ] 批量处理：粘贴长文分段润色
- [ ] Windows 支持：`capture.js` 添加 win32 分支

### P3 — 高级功能
- [ ] 学术模式：针对论文的专业术语保留和格式适配
- [ ] 翻译润色：英→中翻译后自动润色
- [ ] 插件系统：允许用户编写自定义处理 Agent

---

## 9. 变更日志

### v1.0.1 (2026-04-09) — 构建验证通过

**变更**:
- 添加 `assets/` 托盘图标文件 (tray-iconTemplate.png)
- 更新 `src/tray.js` — 使用实际图标文件替代空图标
- 更新 `package.json` — build.files 包含 assets 目录
- Node.js v20.18.1 安装到 `~/local/node/`，npm 镜像源配置为 npmmirror
- 依赖安装验证通过，应用启动无错误

### v1.0.0 (2026-04-09) — 初始版本

**新建文件**:
- `main.js` — 主进程入口
- `preload.js` — 安全桥接
- `package.json` — 项目配置
- `src/config.js` — 配置管理
- `src/capture.js` — 文本捕获
- `src/shortcuts.js` — 快捷键管理
- `src/windows.js` — 窗口管理
- `src/tray.js` — 系统托盘
- `src/diff.js` — Diff 引擎
- `src/ai/base-provider.js` — Provider 基类
- `src/ai/openai-provider.js` — OpenAI 实现
- `src/ai/ollama-provider.js` — Ollama 实现
- `src/ai/provider-factory.js` — Provider 工厂
- `src/ai/pipeline.js` — 多智能体管线
- `src/renderer/result/` — 结果窗口 (HTML + CSS + JS)
- `src/renderer/settings/` — 设置窗口 (HTML + CSS + JS)
