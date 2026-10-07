# 润石 Word / WPS 文档助手

这套插件复用润石现有账号、积分和 AI 后端，只把用户主动选择的文字发送到服务器。生成建议后，用户可逐条接受或忽略；写回前会再次核对原文，避免覆盖刚发生的编辑。

## 构建

```bash
npm run build:addins
```

构建产物位于 `integrations/dist`，线上固定部署到 `https://www.runshi.top/addins/`。

## Word

安装清单地址：`https://www.runshi.top/addins/word/manifest.xml`。可由 Microsoft 365 管理中心集中部署，也可在开发阶段旁加载。安装后从 Word 的“开始”选项卡打开“润色选区”。

## WPS

WPS 源文件包括 `manifest.xml`、`ribbon.xml`、`main.js`、任务窗格和适配器。正式分发应使用 WPS 官方 `wpsjs publish` 流程生成安装页面/包，并在目标 Windows WPS 环境完成签名、安装和兼容性测试。

## 安全边界

- 不自动上传整篇文档。
- 登录令牌仅保存在插件会话存储，关闭任务窗格后由宿主清理。
- 全部业务请求走 `https://www.runshi.top`。
- 写回前比对当前选区和分析时的选区；不一致时拒绝覆盖。
- 不在文档自定义属性、正文或日志中保存令牌和原文。
