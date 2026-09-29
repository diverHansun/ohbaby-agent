# 01 当前问题

`api/daemon/client.ts` 初始与重连会自行生成全页 `snapshot.replaced`；`eventReducer.ts` 收到后替换状态并清空局部思考。`ui/selectors.ts` 把发送、Stop 和输入框禁用都绑在全局 connectionState，因此聊天恢复或附加读取的失败会影响无关操作。

受影响的原设计文档：[architecture.md](../architecture.md)、[data-model.md](../data-model.md)、[states.md](../ui/states.md)、[test.md](../test.md)。这些文件保持原样；全链路原因与基线证据见[中央 01](../../problem-lists/2026-09-19-execution-reliability/improve-1.1/01-problem-analysis-and-current-state.md)。

返回：[本模块索引](README.md)。
