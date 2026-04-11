# 润石 PoliShit

跨平台（macOS / Windows）中文文本润色桌面应用。选中文字，一键润色 / 降重 / 降AI率（图一乐版），Grammarly 风格逐条审阅。

## 主要功能

- 选中文字后浮窗自动弹出，点击即触发 `润色`、`降重`、`降AI率（图一乐版）`
- 全局快捷键触发（默认 `Ctrl+Shift+A` / `⌘⇧A`）
- Grammarly 风格逐条审阅修改建议，按条接受或忽略
- 内置 Together AI / SiliconFlow 免费预设，也支持 DeepSeek、豆包、Gemini、Claude、OpenAI、Ollama 及自定义接口
- 支持自定义提示词，为每种模式添加额外偏好

## 下载安装

从 [Releases](https://github.com/nicecho/runshi/releases) 下载对应平台安装包：

- **macOS**: `润石 PoliShit-x.x.x-arm64.dmg`
- **Windows**: `润石 PoliShit Setup x.x.x.exe`

> **macOS 首次打开提示无法验证？** 应用未经 Apple 付费签名，macOS 会拦截。**右键点击应用 → 打开 → 再点「打开」**即可，仅首次需要。
> 若仍提示「已损坏」，在终端执行：`xattr -cr /Applications/润石\ PoliShit.app`

## 开发环境

- Node.js 18+
- macOS / Windows 均可开发和运行

```bash
npm install
npm start
```

## 测试

```bash
npm test
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
- **Windows**: 使用复制文本回退或全局快捷键触发。
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

## 作者

**Choras Chan** — [choraschan.github.io](https://choraschan.github.io)

## 开源协作

欢迎提 issue / PR。详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
