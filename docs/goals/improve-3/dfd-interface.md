# goals 第 3 批接口与用例

> 执行准入与结算基建继承 [improve-2/dfd-interface](../improve-2/dfd-interface.md)，停止状态定义见 [architecture](./architecture.md)。

## 恢复

```text
/goal resume                       检查现有额度后恢复
/goal resume 100 turns             设置轮次总额度，时间不变
/goal resume 3h                    设置活跃时长总额度，轮次不变
/goal resume 100 turns 3h          一次设置两轴，允许反序
```

命令解析完整消耗参数，拒绝重复维度、未知单位、缺值、非有限/非正数、非整数轮数、超限与尾部垃圾。命令与 SetGoalBudget 共用 budget-input 的校验；服务用 planResume 合并最新预算并检查两轴与独立安全阀。失败返回 invalid_budget、budget_reached 或 safety_cap_reached；两轴同时到顶必须一次给足两项总额。SetGoalBudget 单独调额度不激活停止目标。没有 `/goal budget` 命令。

```text
命令参数 → parseGoalResumeBudget → GoalService.resumeGoal(session, limits)
          → session mutation: 最新快照 → planResume → store.resumeWithBudget
          → 区外重排时间截止 → ensureDriving
```

## 模型工具

UpdateGoal 只接受 complete / blocked。complete 忽略 reason；blocked trim 后必须非空。工具继续从 context 传可信 runId，不把执行身份放入模型 schema。普通用户主 run 保留既有 create/budget/complete 权限，但不能贡献 blocked 审计。未知或旧 run 拒绝 mutation。

模型每个真正受阻轮调用一次 blocked；前两次返回仍 active 与 1/3、2/3，第三次保存 blocked。不能在提示中再要求模型先等三轮才调用。静态 system 规则、续跑规则和工具描述同批同步，稳定 system 前缀不按运行状态改写。

## 客户端

CLI 常驻文字直接显示 goal blocked，沿用已有 warning 色。Web chip 用现有单色形状区分 blocked，面板支持 paused/blocked 恢复。

Web 面板的两个可选字段是轮次总额和活跃时长总额，留空不改该维度；命令仍由后端解析。失败保留面板及填写值，显示具体错误。composer 的带参数 `/goal resume ...` 通过受控 allowOverlay 分支把完整命令送到现有 runtime，保留目录、session 和 binding 校验；无参数仍打开面板。其他 overlay 命令不因此获得通用直通权限。

本批不改变压缩算法或用户消息分流，不接自动 steer。paused 的历史 light note 暂保留，blocked 不经 legacy paused 归一化也不新增该 note；improve-5 统一移除非活跃自动注入。
