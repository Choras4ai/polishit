# 润石 PoliShit

润石 PoliShit 是一个 Electron 桌面应用，用来对中文文本做润色、降重、降AI率（图一乐版）。交互方式围绕“选中即处理”展开：可以直接选中文本后触发，也可以在不支持选区读取的应用里先复制文本作为回退方案。

## 主要功能

- 选中文字后，用浮窗触发 `润色`、`降重`、`降AI率（图一乐版）`
- 支持全局快捷键触发
- 逐条审阅修改建议，并按条接受或忽略
- 内置 Together / SiliconFlow 预设，也支持自定义兼容 OpenAI 的接口

## 开发环境

- Node.js 18+
- macOS 13+（浮窗最佳体验）
- Windows 可运行，但“选中文本即弹出”依赖平台能力，建议同时使用复制回退和快捷键

本机如果 `npm` 不在默认 `PATH`，可使用：

```bash
PATH=/Users/choras/local/node/bin:$PATH npm install
PATH=/Users/choras/local/node/bin:$PATH npm start
```

如果当前 shell 设置了 `ELECTRON_RUN_AS_NODE=1`，启动 Electron 前需要去掉它：

```bash
env -u ELECTRON_RUN_AS_NODE PATH=/Users/choras/local/node/bin:$PATH npm start
```

## 本地运行

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
npm run build
```

构建产物名称默认会带上 `润石 PoliShit`。

## 浮窗排障

### 1. 选中文本后没有浮窗

macOS 下，这条链路依赖“辅助功能”权限。

在应用内打开：

`设置 -> 高级 -> 浮窗工具栏 -> 打开辅助功能设置`

也可以手动前往：

`系统设置 -> 隐私与安全性 -> 辅助功能`

确保当前应用已被允许控制电脑。

### 2. 某些应用里选中了文字，但还是不弹

有些应用不会对外暴露 `AXSelectedText`。这种情况下：

- 先复制选中的文本，浮窗会走复制回退链路
- 或直接使用全局快捷键

### 3. 快捷键可用，但浮窗不可用

这通常不是 AI 或接口问题，而是输入监听链路问题：

- 检查“浮窗工具栏”开关是否打开
- 检查 macOS 辅助功能权限
- 尝试先复制文本，确认复制回退是否正常

## 项目结构

- `main.js`：主进程入口、IPC、全局触发流程
- `src/selection-watcher.js`：选区监听与复制回退
- `src/capture.js`：选中文本捕获与原位粘贴
- `src/renderer/`：设置页、结果页、引导页、浮窗 UI
- `src/ai/`：AI provider 与处理流水线

## 开源协作

欢迎提 issue / PR。提交前请至少完成：

1. 复现并描述问题
2. 说明运行平台与应用版本
3. 运行 `npm test`
4. 涉及浮窗问题时附上权限状态和目标应用名称

更多细节见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 安全

安全问题请不要公开提交在 issue 中，见 [SECURITY.md](./SECURITY.md)。

## License

仓库当前还没有附带正式许可证。公开发布到 GitHub 前，请补充你明确选择的 `LICENSE` 文件。
