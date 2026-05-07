# 润石 PoliShit 项目技术报告

> 版本：v1.6.1  
> 日期：2026-05-06  
> 作者：陈实之  
> 仓库：https://github.com/Choras4ai/polishit  
> 官网：https://www.runshi.top

## 1. 项目概述

润石 PoliShit 是一款面向中文写作者的跨平台桌面应用，核心目标是在 Word、WPS、VSCode、浏览器文本框等常见写作环境中，提供类似 Grammarly 的“选中即改、逐条审阅”体验。当前版本只保留两个面向用户的文本处理功能：

- `润色`：以最小改动原则修正语法、标点、错别字、搭配、冗余和局部表达问题。
- `降AIGC`：去除文本中过度模板化、机械化的表达，使文字更自然，但不承诺规避任何检测系统。

产品定位是写作辅助工具，不提供论文代写、代投、考试作弊或规避学术规范的服务。所有 AI 输出均作为建议，用户需要自行审阅并承担最终文本责任。

## 2. 当前版本状态

| 项目 | 当前状态 |
| --- | --- |
| 桌面端版本 | `1.6.1` |
| 应用名称 | `润石 PoliShit` |
| 支持平台 | macOS / Windows |
| 官网 | `https://www.runshi.top` |
| 更新清单 | `https://www.runshi.top/version.json` |
| macOS 安装包 | `downloads/runshi-polis-1.6.1-arm64.dmg` |
| Windows 安装包 | `downloads/runshi-polis-setup-1.6.1.exe` |
| 自动化测试 | `node --test`，当前 30+ 用例 |
| 商业后端 | Node.js + SQLite，本地可运行 |
| 支付状态 | 微信 / 支付宝回调代码已预留，真实商户未联调 |

## 3. 总体架构

项目采用 Electron 桌面客户端 + 可选商业后端 + 静态官网的架构。

```text
用户选中文本
  ↓
selection-watcher / capture
  ↓
main.js IPC 编排
  ↓
AgentPipeline
  ↓
AI Provider
  ├─ 自配 API：客户端直连用户配置的模型服务
  ├─ 会员托管：客户端请求润石后端，由后端代理上游模型
  └─ Ollama：本地模型离线处理
  ↓
DiffEngine
  ↓
结果窗逐条审阅
  ↓
接受 / 忽略 / 复制 / 原位写回
```

### 3.1 客户端模块

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 主进程 | `main.js` | 生命周期、窗口、IPC、触发流程、更新检查、商业状态编排 |
| 安全桥接 | `preload.js` | 通过 `contextBridge` 暴露白名单 API |
| 配置 | `src/config.js` | electron-store 配置、默认值、商业模块开关 |
| 捕获与写回 | `src/capture.js` | 剪贴板捕获、跨应用粘贴、Word 原位修订 |
| 选区监听 | `src/selection-watcher.js` | macOS 选区探测、浮窗触发、复制回退 |
| macOS Helper | `src/macos-selection-helper.js` + `scripts/selection_probe.swift` | Accessibility 选区、范围、bounds 探测 |
| 窗口管理 | `src/windows.js` | 结果窗、设置窗、首页、工具条、撤销窗 |
| 托盘 | `src/tray.js` | 系统托盘菜单 |
| 快捷键 | `src/shortcuts.js` | 全局快捷键注册与更新 |
| Diff | `src/diff.js` | 字符级差异计算、修改范围标记 |
| AI 管线 | `src/ai/pipeline.js` | 语言检测、提示词、模型输出清洗、解释生成 |
| Provider | `src/ai/*provider.js` | OpenAI 兼容、Anthropic、Ollama、商业代理 |
| 商业客户端 | `src/commercial/client.js` | 登录、积分、订单、模型列表、后端代理状态 |
| 更新 | `src/updater/index.js` | version.json / GitHub Releases 检查与提示 |

### 3.2 渲染层

| 页面 | 文件 | 说明 |
| --- | --- | --- |
| 首页 | `src/renderer/home` | 首次入口、快速跳转 |
| 引导页 | `src/renderer/onboarding` | 首次配置和权限引导 |
| 工具条 | `src/renderer/toolbar` | 选区附近的润色 / 降AIGC 入口 |
| 结果页 | `src/renderer/result` | 修改建议、逐条审阅、完整修改稿、Word 写回状态 |
| 设置页 | `src/renderer/settings` | API 配置、账户、积分、快捷键、提示词、更新 |
| 撤销窗 | `src/renderer/undo` | 标准粘贴替换后的撤销入口 |

## 4. 文本处理链路

### 4.1 捕获

macOS 下优先使用 Accessibility 能力读取当前选区文本、范围和屏幕位置；失败时回退到模拟复制。Windows 主要依赖复制回退和全局快捷键。

捕获流程包括：

1. 记录当前前台应用。
2. 尝试读取选区上下文。
3. 保存剪贴板。
4. 写入哨兵值并模拟复制。
5. 读取剪贴板文本。
6. 恢复原剪贴板。
7. 建立本次批阅会话。

### 4.2 处理

`AgentPipeline` 根据任务类型和语言选择提示词：

- 中文润色：学术、商务、随笔三种体裁规则。
- 英文润色：最小改动、保留专业术语和论断强度。
- 降AIGC：删除模板化连接词、打破机械句式、保留事实和结构。
- 自定义提示词：设置页可为 `润色` 和 `降AIGC` 分别追加用户偏好。

模型输出会先经过 `normalizeModelOutputText()` 清洗，统一换行、空格和零宽字符，避免结果页出现“多 1 条不可见修改”的问题。

### 4.3 审阅与写回

结果页使用字符级 diff 展示修改建议，用户可以逐条接受或忽略。macOS 支持两类写回：

- 通用应用：通过 Accessibility 重新定位选区并粘贴 / 删除。
- Microsoft Word：优先使用当前 Word 活选区整段回写；失败后回退到 range 定位，并尝试附近偏移位点。

如果 Word 写回失败，结果窗会明确提示“仅当前窗口暂存，Word 原文尚未改动”，避免把本地接受状态误认为已经修改原文。

## 5. AI Provider 与模型配置

客户端支持以下 Provider：

- OpenAI 兼容接口：Together AI、DeepSeek、硅基流动、豆包、Gemini、OpenAI、自定义接口。
- Anthropic：Claude 原生接口。
- Ollama：本地离线模型。
- 商业代理：登录后通过润石后端转发请求。

Provider 创建逻辑在 `src/ai/provider-factory.js`。商业代理的优先级最高；只有当商业模块启用、后端地址和 token 有效且用户没有切到自配 API 时，才会走后端代理。

## 6. 商业后端

商业后端位于 `server/`，技术栈为 Express.js + SQLite。它用于账号、积分、试用、签到、订单、支付回调和 AI 请求代理。

### 6.1 核心接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查、支付通道状态、回调地址 |
| `POST /api/device/register` | 设备注册，支持免登录试用 |
| `POST /api/auth/register` | 邮箱注册 |
| `POST /api/auth/login-email` | 邮箱登录 |
| `POST /api/auth/send-code` | 手机验证码发送，当前支持 mock |
| `POST /api/auth/login` | 手机验证码登录 |
| `GET /api/auth/me` | 当前账户状态 |
| `POST /api/checkin` | 每日签到加积分 |
| `GET /api/checkin/status` | 签到状态 |
| `GET /api/membership/plans` | 积分包方案 |
| `POST /api/membership/subscribe` | manual 模式直充积分 |
| `POST /api/pay/create-order` | 创建支付订单 |
| `GET /api/pay/orders/:id` | 查询订单状态 |
| `POST /api/pay/callback/wechat` | 微信支付回调 |
| `POST /api/pay/callback/alipay` | 支付宝异步回调 |
| `POST /api/ai/chat` | 代理 AI 请求并扣减额度 |

### 6.2 积分策略

当前方案为积分包而不是月会员：

- `runshi-basic`：`¥9.9 / 300 积分`
- `runshi-pro`：`¥29.9 / 1000 积分`
- 标准计费：约 `800 字 / 1 基础积分`
- 支持 `0.5` 积分粒度
- 高阶模型按倍率消耗
- 上游请求失败会自动退款

新用户可配置 `RUNSHI_TRIAL_FREE_USES=10` 获得 10 次试用，同时可配置 `RUNSHI_INITIAL_CREDITS=5` 获得初始基础积分。

### 6.3 稳定性与防刷

后端包含以下保护：

- `rate-limiter`：按设备 / 用户 / 全局 QPS 限流。
- `request-queue`：限制并发和队列长度。
- `circuit-breaker`：上游错误率或延迟异常时熔断。
- `cost-guard`：日/月成本预算保护。
- `activeUsageLocks`：同一身份同时只允许一个 AI 任务，避免并发刷额度。
- 支付回调重复处理保护：订单状态已支付时不会重复入账。

## 7. 支付与订单

当前代码已预留微信支付和支付宝链路：

- 微信 Native 下单与回调验签。
- 支付宝网页支付、异步通知验签和同步返回页。
- 回调时间窗口校验。
- 订单金额、通道和状态校验。
- 支付成功后按订单积分入账。

正式上线前仍需完成真实商户联调：

1. 使用公网 HTTPS 域名配置 `RUNSHI_PUBLIC_BASE_URL`。
2. 配置 `RUNSHI_PAYMENT_PROVIDERS=wechatpay,alipay`。
3. 填写微信支付商户号、证书、APIv3 Key。
4. 填写支付宝 AppId、私钥、公钥。
5. 在商户平台配置回调地址。
6. 用真实小额订单验证下单、支付、回调、入账、重复通知。

在未接入真实商户前，生产环境不应把支付功能标记为正式可用。

## 8. 数据安全与隐私

润石必须按实际数据路径向用户说明：

- 自配 API：正文直接从客户端发送到用户填写的模型服务商。
- 会员托管：正文发送到润石后端，再由后端转发给上游模型。
- Ollama：本地模型处理，正文不离开本机。

客户端不会把用户自配 API Key 上传到润石后端。后端仅处理账户、设备、会话、订单、积分、签到、请求元数据和必要日志。服务端不应将用户正文用于训练，也不应主动保留不必要的正文副本。

## 9. 官网与更新链路

官网静态文件位于 `docs/`。

| 文件 | 说明 |
| --- | --- |
| `docs/index.html` | 产品官网首页、功能、积分、下载 |
| `docs/terms.html` | 用户协议与免责声明 |
| `docs/technical-report.html` | 本报告的网页版 |
| `docs/version.json` | 自动更新检查清单 |
| `docs/downloads/` | 安装包下载目录 |
| `docs/CNAME` | 自定义域名 `www.runshi.top` |

发布方式：

- GitHub Actions：`.github/workflows/deploy-pages.yml` 会在 `docs/**` 变更时部署 GitHub Pages。
- 手动脚本：`scripts/deploy-pages.sh` 发布到 `gh-pages` 分支，不覆盖源码主分支。

自动更新逻辑优先读取 `https://www.runshi.top/version.json`，失败时回退到 GitHub Releases。

## 10. 开源版与商业版拆分

商业能力通过 `RUNSHI_COMMERCIAL_AVAILABLE` 控制：

- `RUNSHI_COMMERCIAL_AVAILABLE=1`：显示账户、积分、后端代理等商业能力。
- `RUNSHI_COMMERCIAL_AVAILABLE=0`：隐藏商业入口，回到纯自配 API 的开源工具形态。

当前代码结构已把商业模块集中在：

- 客户端：`src/commercial/`
- 后端：`server/`
- 商业配置：`.env.example`
- 商业说明：`COMMERCIAL_SETUP.md`

如果发布纯开源版，应同时确认官网、README、协议中不会描述商业功能为默认能力。

## 11. 测试与质量

当前自动化测试覆盖：

- Provider 工厂和商业代理分支。
- 模型超时策略。
- 积分计费策略。
- 支付订单状态与回调重放防护。
- 商业账户字段兼容。
- 熔断器 half-open 并发控制。
- 更新清单解析。
- 提示词与模型输出归一化。
- 默认积分包配置。

推荐回归命令：

```bash
npm test
node --check main.js
node --check preload.js
node --check src/capture.js
node --check src/ai/pipeline.js
node --check src/renderer/result/script.js
node --check src/renderer/settings/script.js
node --check docs/site.js
node --check server/index.js
```

桌面端人工回归重点：

- Word 选中文本后浮窗出现。
- 点击润色后结果窗正常展示。
- 接受单条修改后 Word 原文实际变化。
- 写回失败时结果窗不会误报“已改原文”。
- `完成批阅` 能把已接受内容同步回原文。
- 设置页账户、API、提示词、更新检查能正常打开和保存。

## 12. 当前已修复的关键问题

1. Word 原位批阅失败但 UI 显示“已接受”的状态误导。
2. Word range 定位过脆导致“当前原文已变化”。
3. 模型输出中的零宽字符、NBSP、换行差异导致不可见修改计数。
4. 商业后端默认方案 ID 仍指向旧月会员，导致默认充值路径找不到方案。
5. 发布脚本指向 1.5.0 安装包。
6. 手动发布脚本原来会覆盖推送到 `main`，现在改为 `gh-pages`。
7. 官网免费额度、积分包、版本、下载入口与代码状态不一致。

## 13. 上线风险清单

正式上线前仍需处理：

- 真实微信 / 支付宝小额订单全链路联调。
- 生产 HTTPS 域名、CORS 白名单、反向代理与日志轮转。
- Apple Developer ID 签名与 notarization，否则 macOS 会继续提示无法验证。
- Windows 代码签名，否则会被 SmartScreen 拦截。
- 生产数据库备份和迁移策略。
- 后端错误监控、成本告警和用户客服入口。
- 隐私政策按真实部署方式再做一次法律审查。

## 14. 结论

润石 PoliShit v1.6.1 的核心桌面功能、AI 管线、积分包后端、官网和更新链路已经形成闭环。当前版本适合作为内测版或开源预览版继续打磨。若要正式商业上线，支付商户、HTTPS 部署、签名公证、生产监控和合规文本仍需要完成真实环境验证。
