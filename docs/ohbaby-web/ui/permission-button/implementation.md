# Permission Buttons · 实现与测试

`PermissionModal` 位于 `apps/ohbaby-web/src/ui/App.tsx`，消费独立审批列表及同步状态。它在聊天主视图之外挂载，因此审批入口不等待完整历史或 composer 就绪。

## 样式映射

| 当前选项     | id           | intent | 修饰类                   |
| ------------ | ------------ | ------ | ------------------------ |
| Allow once   | allow_once   | allow  | ohb-perm-allow-primary   |
| Always allow | allow_always | allow  | ohb-perm-allow-secondary |
| Reject       | reject       | deny   | ohb-perm-deny            |

共享基类为 `.ohb-perm-btn`。`permissionButtonClass` 先识别 allow_always，再处理通用 allow，其他可见选项使用 deny 样式。现有 abort 分支/CSS 可保留，但渲染前过滤 `id === "cancel"` 或 `intent === "abort"`，不能因此重新开放 Cancel run。

## 同步与应答

- 数据来自 `createPermissionSync`，不从全量 snapshot 的兼容 permissions 重建。
- 按 createdAt/id 稳定排序，局部 selectedId 支持 Previous/Next；请求消失时回到可用项。
- 只有独立 status=ready 才启用回答。同步失败显示原因及恢复入口；PERMISSION_UNAVAILABLE 不自动重试。
- 应答携带当前 epoch/root/bindingGeneration。PERMISSION_NOT_PENDING 触发同步，已合法回答可幂等成功；HTTP 成功不等于工具已执行。
- same callId 的后续 permissionId 是新请求，不能继承上一次选择。旧范围回调不得重新启用新范围。

## 验证落点

`App.unit.test.tsx` 验证来源、无取消按钮、非首项选择及独立就绪；daemon client 的 integration 测试验证重连、范围切换、聊天失败与旧响应隔离。`styles.unit.test.ts` 保留样式规则验证，兼容 CSS 的存在不代表公开 choice。
