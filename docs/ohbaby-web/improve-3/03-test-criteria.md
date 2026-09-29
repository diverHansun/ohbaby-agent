# 3. Web 模块测试归属与交接

本文件只说明测试放哪里、由哪个模块承担；场景、断言与唯一编号在[中央04](../../problem-lists/2026-09-19-execution-reliability/improve-2.1/04-test-and-acceptance.md)。不能维护一套不同的Web验收门。

| 模块 / 接缝 | 中央验收ID | 测试归属 |
| --- | --- | --- |
| runtime/client拆分、store订阅、workspace切换 | T01/T08/T13 | 保留api/daemon既有integration；runtime局部测试随实际入口迁移 |
| New按钮、same-scope恢复提示 | T02/T07/T08/T16 | browser client+store集成、session局部hook；server生命周期测试按中央路径 |
| session提交投影与Composer接管 | T09/T12 | 原App跨功能测试保留；session投影规则unit；session/Composer装配用例 |
| composer草稿、IME、队列编辑、reasoning | T09 | composer模块unit/contract及相邻fixture；跨服务端租约用例保留integration |
| conversation消息、工具、计时、分页滚动 | T10 | conversation相邻unit/contract；实际浏览器滚动/刷新走中央E2E |
| Composer单一键盘链、commands纯规则/展示、workspace/permissions接线 | T11/T12 | Composer键盘与commands规则/组件测试 + App集成；断言一次按键至多一个动作及异步scope/revision防迟到，不能只测孤立组件回调 |
| CSS与测试迁移 | T14/T15 | 全局入口测试、功能测试、构建CSS和同viewport浏览器证据 |
| 依赖边界与组合门 | T17 | 类型/构建、import图、SWE子代理及完整套件 |

源码提取期间原`App.unit.test.tsx`作为行为保护网，只做必要import/fixture定位调整；待提取稳定后，按用例职责迁移并保留旧场景→新文件映射于实施说明/05，不在规划文件打勾。无需让每个小helper都有新test文件；测试保护风险，不照抄实现。

验收必须同时回答：新模块是否实际接入、状态是否只有一个协调者、旧页面行为是否保持。不能以App行数降低或目录齐全代替答案。

返回：[模块规格](02-change-spec.md)；[阶段索引](../../problem-lists/2026-09-19-execution-reliability/improve-2.1/README.md)。
