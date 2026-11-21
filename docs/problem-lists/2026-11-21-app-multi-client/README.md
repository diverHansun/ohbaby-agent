# App 端前置：多客户端与版本

本议题于 2026-11-21 开启，是做 App 端之前要先定下来的一组前置条件：TUI、Web、App 三个客户端怎么共存，同一个会话在两个客户端里怎么处理，以及 App 自带的运行时和单独安装的 CLI 版本不一致时怎么办。

App 的打包方式（Electron、签名、自动更新等）放在姊妹议题 [App 打包](../2026-11-21-app-packaging/README.md)。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-21 | 首轮 | 客户端共存、同会话处理、版本策略、自改自测的隔离方式 | 讨论中 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定、参考项目依据和待讨论项 |

## 相关议题

| 议题 | 关系 |
|---|---|
| [全局单 daemon](../2026-07-11-global-single-daemon/README.md) | 本议题的基础：全机一个 serve、TUI 永久 in-process、run claim 防双写、版本精确一致 |
| [Workspace prompt 并发](../2026-07-12-workspace-prompt-concurrency/README.md) | daemon 内同一会话先进先出排队，App 作为客户端直接沿用 |
| [脚本安装](../2026-11-17-script-install/README.md) | CLI 的安装渠道。App 单独发布安装包，不写入脚本安装目录，两条渠道互不干涉 |
| [App 打包](../2026-11-21-app-packaging/README.md) | 姊妹议题 |
