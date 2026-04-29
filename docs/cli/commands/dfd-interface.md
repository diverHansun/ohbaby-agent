# cli/commands 退役说明 dfd-interface.md

`cli/commands` 不再参与运行时数据流。

---

## 一、Context & Scope（上下文与范围）

旧数据流：

```
UI Layer → cli/commands → commands
```

新数据流：

```
UI surface → ohbaby-sdk parser/resolver → UiBackendClient → backend commands → SDK events → UI surface
```

---

## 二、Data Flow Description（数据流描述）

没有数据进入 `cli/commands`。旧数据流已迁移：

1. Slash 输入由 surface 调用 SDK parser。
2. Command catalog 由 backend 提供。
3. Command invocation 通过 `UiBackendClient.executeCommand()` 提交。
4. Command result 通过 SDK events 回流。
5. Surface 自行渲染 events。

---

## 三、Interface Definition（接口定义）

不再提供：

- `executeSlashCommand()`
- `getSlashCommandCompletions()`
- `getSlashCommandHelp()`
- `isSlashCommand()`

对应能力见：
- `docs/ohbaby-sdk/dfd-interface.md`
- `docs/commands/dfd-interface.md`
- `docs/ui/dfd-interface.md`

---

## 四、Data Ownership & Responsibility（数据归属与责任）

`cli/commands` 不拥有任何运行时数据。

---

## 五、文档自检

- [x] 明确数据流已迁移。
- [x] 不再暴露旧接口。
