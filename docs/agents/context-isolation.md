# 子代理上下文隔离

每个子代理使用独立的 `sessionId + contextScopeId` 读写消息、组装模型上下文、执行压缩和租用 sandbox。多个实例可以共享 child session，但不得共享 scope 历史；子代理不继承主会话 transcript。

主代理通过 `agent spawn` 传初始任务，通过 `agent send` 传后续任务或运行中消息。新执行由 `core/agents.runAgent` 写入初始输入；运行中消息由持久输入通道写入目标 child run，并在下一请求读取。一次执行固定其模型；空闲实例的新执行重新解析当前会话模型。

前台结果经工具返回；后台结果进入所属主会话的 pending delivery。主代理只接收结果或结果文件路径，完整历史通过 `agent monitor` 按保存记录读取。UI 详情和模型历史读取各自遵守权限边界。

shell owner 使用实际 child run。主轮次完成或 Stop 不取消后台执行；stop 只取消当前 child execution，close 清理整个实例。context 的销毁等待必要资源退出确认，兄弟 scope 不受影响。运行名额按实际执行计数，与实例数量及自然遗留后台 shell 分开。

`closedAt` 是不可逆控制边界：close 后不能 send 或重建运行，list 隐藏实例，monitor 仍可读取持久历史。详细取消、恢复和交付规则见 [dfd-interface.md](./dfd-interface.md)。
