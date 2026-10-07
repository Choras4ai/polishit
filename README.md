# 润石 PoliShit

跨平台（macOS / Windows）中文文本润色桌面应用。选中文字，一键润色 / 降AIGC，Grammarly 风格逐条审阅。

当前版本：**[v1.6.11](https://github.com/Choras4ai/polishit/releases/tag/v1.6.11)** · [更新日志](CHANGELOG.md) · [波江座 NEO LAB](https://www.runshi.top/lab/)

[下载 macOS Apple Silicon](https://github.com/Choras4ai/polishit/releases/download/v1.6.11/runshi-polis-1.6.11-arm64.dmg) · [下载 Windows x64](https://github.com/Choras4ai/polishit/releases/download/v1.6.11/runshi-polis-setup-1.6.11.exe)

### 1.6.11 更新

- Mac Word 分析后自动显示原文下划线与悬停建议，支持直接接受、忽略。
- 修复“接受全部”写回与状态问题，显示逐条进度，失败保留待处理建议。
- Word 已开启原生“修订”时，写入前提示关闭后重试。
- Windows 已完成自动化与打包检查，尚未完成 Word 真机验收。其他编辑器的原文浮窗取决于辅助功能接口支持，不支持时使用结果窗审阅。

历史补档版本的安装包和校验值见 Releases；部分历史版本没有保存完整源码快照，其归档标签仅包含版本说明和校验清单，不代表可重建源码。当前 main 分支是 1.6.11 源码。

## 主要功能

- 选中文字后浮窗自动弹出，点击即触发 `润色`、`降AIGC`
- 全局快捷键触发（默认 `Ctrl+Alt+V` / `⌘⌥V`）
- Grammarly 风格逐条审阅修改建议，按条接受或忽略
- 支持 Together AI、DeepSeek、豆包、Gemini、Claude、OpenAI、Ollama 及自定义接口
- 支持自定义提示词，为每种模式添加额外偏好
- 启动后自动检查官网版本清单（GitHub Releases 作为备用来源），并在「关于」页支持手动检查更新

## 数据路径

- `自配 API`：文本直接发送到你填写的模型服务商。
- `会员托管`：文本先发送到润石后端，再由后端转发到配置的上游模型。
- 项目默认不保存历史正文；账户、订单、额度、签到与基础运行日志会按后端需要写入数据库。

## 下载安装

从 [Releases](https://github.com/Choras4ai/polishit/releases) 下载对应平台安装包：

- **macOS**: `runshi-polis-x.x.x-arm64.dmg`
- **Windows**: `runshi-polis-setup-x.x.x.exe`

### macOS 安装步骤

> 当前 macOS 安装包采用临时签名，尚未经过 Apple 公证，首次打开可能被系统拦截。请从本项目发布页下载并核对 SHA-256。

1. 双击下载的 `.dmg` 文件
2. 把「润石 PoliShit」图标拖进「应用程序」文件夹
3. 打开「应用程序」文件夹，找到「润石 PoliShit」
4. **右键**点击它 → 选择「**打开**」
5. 在弹出的对话框中点击「**打开**」
6. ✅ 仅首次需要这样操作，之后双击即可正常打开

<details>
<summary>右键打开仍提示「已损坏」？</summary>

打开「终端」（在 Spotlight 搜索 `终端`），粘贴执行：

```bash
xattr -cr /Applications/润石\ PoliShit.app
```

然后重新打开应用即可。这个命令只是移除 macOS 的隔离标记，不会影响应用功能。
</details>

## 开发环境

- Node.js 22.12+（本次验证使用 Node.js 24.20.0）
- macOS / Windows 均可开发和运行

```bash
npm ci
npm --prefix server ci
npm run build:native
npm start
```

## 测试

```bash
npm test
# 先构建并启动本地官网（127.0.0.1:18787），再运行隔离 UI 检查
npm run build:site
npm run test:ui
```

## 构建

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# 全平台
npm run build:all
```

## 浮窗排障

### 选中文本后没有浮窗

- **macOS**: 需要授予辅助功能权限。前往 `系统设置 → 隐私与安全性 → 辅助功能`，确保应用已被允许。
- **Windows**: Word 提供 COM 选区定位与写回；其他应用按接口能力使用选区捕获或复制回退。
- 某些应用不暴露选区信息，可先复制文本再触发。

### 快捷键可用，但浮窗不弹

- 检查「浮窗工具栏」开关（设置 → 通用）
- 尝试复制文本确认回退链路

## 项目结构

- `main.js` — 主进程入口、IPC、全局触发流程
- `src/selection-watcher.js` — 选区监听与复制回退
- `src/capture.js` — 选中文本捕获与原位粘贴
- `src/renderer/` — 设置页、结果页、引导页、浮窗 UI
- `src/ai/` — AI provider 与处理流水线
- `TECHNICAL_REPORT.md` — 当前版本完整技术报告

## 作者

**陈实之** — [小红书主页](https://www.xiaohongshu.com/user/profile/5baad820f7e8b908db85cf62)

## 开源协作

欢迎提 issue / PR。详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

### 编辑器兼容性与回归验证

桌面 App 只在能够核对原文内容与位置的编辑器中直接写入。Mac Word 已实测原文浮窗；Windows Word 已实现 COM 定位与直接写回，尚待真机验收。不支持可靠范围验证的编辑器会回退结果窗与复制流程。桌面直接写回与 Word / WPS 加载项的原生修订是不同模式；文档切换或原文变化后应重新分析。

开发验证：`npm test` 运行自动测试，`npm run test:ui` 构建并检查网页与隔离的 App 页面，`npm run test:app` 用临时配置和数据库启动真实 App 与本地后端。后两项需要可运行 Electron 的桌面会话；不会使用真实支付或 AI 凭据。生产后端设置 `NODE_ENV=production`；未接入真实短信发送服务前使用邮箱密码登录，生产模式会拒绝 mock 验证码和手动充值。
