# ohbaby-web · Permission Buttons UI

当前审批卡片按 backend 的 `choices` 渲染：Allow once、可记忆时的 Always allow、Reject。本轮已移除 Cancel run；旧客户端提交 `cancel` 会被拒绝，不会取消 run 或退化为 Reject。契约见 [improve-1 §2.5](../../../problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md#25-应答接口与最小客户端改动)。

- [color-system.md](./color-system.md)：三种审批动作的配色。
- [sizing-typography.md](./sizing-typography.md)：尺寸、字号和交互态。
- [implementation.md](./implementation.md)：渲染、同步状态和验证落点。

## 选项与作用

| 选项         | id           | intent | 作用                                                    |
| ------------ | ------------ | ------ | ------------------------------------------------------- |
| Allow once   | allow_once   | allow  | 只批准当前独立 permissionId                             |
| Always allow | allow_always | allow  | 记住真实来源 session 的合法 pattern；不切换 full-access |
| Reject       | reject       | deny   | 只拒绝当前请求，模型可处理工具拒绝结果；不停止其他请求  |

同一 callId 可先后产生多个 permissionId，前一次 Allow once 不代表批准后续请求。来源只简短显示 Main agent 或子代理名称，缺名称回退 sessionId。

## 视觉与交互

Allow once 使用唯一的实心蓝；Always allow 使用浅蓝，Reject 使用淡琥珀。字号 13px，按钮专用类不改变 composer 的 Send/Stop 样式。旧 `.ohb-perm-abort` 样式可保留兼容，但当前审批卡不渲染 cancel/abort choice。

多个 pending 按 createdAt/id 稳定排序，用 Previous/Next 选择非首项。只有独立 permissionSync=ready 才能回答，聊天/model 失败不禁用已同步审批；断连、切范围和审批故障则停用按钮。整页 snapshot 的旧 permissions 不覆盖独立列表。

## 验收

- 可记忆请求显示三个动作，不可记忆请求不显示 Always allow，均无 Cancel run。
- 同根另一页面回答后卡片撤下，重复/失效 ID 不造成再次执行。
- 旧请求或旧绑定的回调不能修改新范围。
- 样式验证保留专用类规则；行为由 App 与 daemon client 的审批测试验证。
