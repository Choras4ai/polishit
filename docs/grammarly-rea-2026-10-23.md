# Grammarly REA 检查记录 · 2026-10-23

## 本轮实际执行

读取 `reverse-engineer-anything/SKILL.md` 及连接恢复指南，并实际调用 REA MCP `binary_session({})`。工具已连接，当前 `open=false`，没有可复用的活动分析目标。无需重复安装 skill 或注册 MCP。

限定搜索范围：`/Applications` 的安装文件路径、项目文档及 audit 研究记录、`/Volumes`、`/tmp` 与 `/private/tmp` 两层内名称。未找到 Grammarly 安装程序、DMG、已挂载目标或现存分析包。这是有限范围内的结果，不代表整台机器绝无该文件；未搜索浏览器个人资料。

REA 返回 Ghidra provider 未配置（`GHIDRA_INSTALL_DIR` 未设置，原生反编译器及 Java runtime 检查未满足）。此限制影响原生伪代码分析；工具连接本身正常。没有擅自安装引擎或启动未知程序。

## 可复用历史证据（本轮未重新验证）

项目 `audit/grammarly-interaction-2026-10-14.md` 标记目标为 Grammarly Desktop **1.200.0** 官方 macOS DMG。`audit/rea-grammarly-overlay-2026-10-14.md` 保留以下引用：

| 历史目标 | 历史 Evidence ID | 记录支持的观察 |
| --- | --- | --- |
| 主执行文件 | `ev_05d0c16272aa0d1b70201e650d48957a674fe60f45930851b672936fd0abbfd7` | 曾完成主程序检查 |
| GRAccessibilityKit | `ev_2224b971b4317d140832688f6db63977964ceb96062b48a8c6f69d603d494340` | AXObserver、按位置查询、参数化 AX 属性导入 |
| GRLlamaCore | `ev_dfd62e58fbec92799f6ebbff11f9d8268351613810ef11b3f3a301ec7fd399d0` | 文字标记/范围、光标和窗口接口导入 |
| GRLlamaUI | `ev_82fd901df5dc2a510e8bd2c4c03a0f118a9220eeda9955239300e67403f4b659` | 窗口焦点与 UI 接口导入 |

这些是历史报告的引用，不是本轮重新产生或检索成功的 Evidence。导入符号仅支持能力和架构推断，不能当作已还原算法。

## 问题清单与证据缺口

- 文字区间如何绑定 Word 原文：**未解决**。需要对应函数伪代码、调用关系和运行时输入输出。
- 文字坐标如何随滚动/缩放更新：**未解决**。AX 相关导入不能证明采用哪种缓存、事件合并或轮询频率。
- 接受建议如何校验并原位写回：**未解决**。需要精确定位、原文版本校验与写入调用的完整路径。
- 如何分句、增量分析和丢弃过期响应：**未解决**。现有记录没有实现证据。
- 语法模型和建议排序：**未解决**。客户端包即使恢复，也未必包含服务端模型或排序实现。

下一步应取得明确的官方 Grammarly 客户端包并记录版本与 SHA-256，先做 REA 静态 inventory，定位文字范围、命中测试和写回相关函数，再对必要函数做原生反编译。只有对应代码或实际调用证据足够时才将机制写入迁移设计；润石现有防抖、基线校验等自主设计不能表述为 Grammarly 算法。

本轮没有获得新的 Grammarly 算法，未修改产品代码，未声称完成逆向。
