# 1.7.0 独立流程审查（2026-10-23）

范围：选区监听、原文标注启动、悬停、逐项接受/撤销、共享状态投影。未操作 UI、未执行 AppleScript/PowerShell；以下不代表 Word/Windows 实机验收。

## 已运行

Node 22 执行 `node --test test/source-review.test.js test/source-review-start.test.js test/review-state.test.js test/windows-selection-flow.test.js test/inline-review-ui.test.js`：41 项通过，0 失败。日志 `/tmp/runshi-flow-audit-20261023.log`。

## 问题

1. **原文浮窗重启竞态（已最小复现）**：`SourceReview.start()` 调用 stop 但上一轮 geometry promise 尚未结束，`pending` 仍为 true；新 start 的 refresh 立即返回 undefined，start 直接失败并显示“当前编辑器无法提供原文位置”。复现脚本 `/tmp/repro-review-restart.cjs`，使用真实 SourceReview 类，仅替换窗口/geometry，先启动未完成 geometry，再启动同 token。最小修复：按 epoch 持有 pending 所有权，使新 epoch 可发起定位，旧请求 finally 不清除新请求 pending；补并发启动回归。

2. **macOS 异步选区回调没有取消校验（静态确认）**：`selection-watcher.js` 的 native callback、AppleScript fallback callback、`_probeWordSelection().then()` 不检查 paused/enabled/轮次；`_emitSelection()` 也没有检查。暂停或禁用之后，已发起回调仍能更新 `lastSelectionSnapshot`（main.js 监听器无阻断）。Windows 分支已有 epoch/token 防护，可以复用同样思路，而非只在下一次轮询入口检查。需补暂停/禁用/stop 后旧回调回归；不能据此单独断言它就是 Word 无下划线的根因。

3. **Windows 不会自动开启原文标注（确定行为差距）**：`offerWordSourceReview()` 第一行 `if (!isMac) return`，所以 Windows 分析完成只有手动启动路径。若要求跨平台分析后自动显示，应验证 Windows 原文恢复/geometry 支持后把 gating 改为支持的 Word bundle，而不是 mac-only；没有 Windows 实机证据前不能宣称兼容完成。

## 已见安全措施

原文启动重新校验 document/text/range/PID；浮窗 action 限定 card sender、token、hoverId，写入受共享锁保护；逐项修改使用原文全量 expectedText、原文 range 与目标 range；失败带 sourceMayHaveChanged 时阻断后续修改。现有单测涵盖多数过期会话、几何失效、悬停及 UTF-16 偏移，但均不能替代真实 Word 辅助功能坐标与窗口层级验证。

## 本轮修复验证

上述问题 1、2 已修改共享实现：geometry pending 属于特定 epoch，旧 start 不得停止新 start；macOS native/fallback/Word/WPS 异步回调校验生命周期 epoch，取消 WPS 读取仍处理其拥有的剪贴板恢复。新回归先出现 4 个预期失败，修复后六个相关测试文件共 45 项通过，0 失败（`/tmp/flow-green.log`）。未更改 Windows 自动启动 gate，也未声称实机通过。
