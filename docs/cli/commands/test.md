# cli/commands 退役说明 test.md

`cli/commands` 不再有独立测试套件。

旧测试迁移如下：

| 旧测试 | 新位置 |
|--------|--------|
| parser.test.ts | `ohbaby-sdk` command parser tests |
| completion tests | SDK resolver tests + TUI input tests |
| renderer.test.ts | TUI/stdout renderer tests |
| interactive tests | TUI DialogManager tests |
| commands integration | backend commands tests |

---

## 删除的旧期望

以下旧行为不再成立：

- `/model gemini-pro` 自动推断为 `model.switch`。
- parser 硬编码 `/quit -> /exit`。
- `CommandResult.interactive.dialog` 指定 UI dialog 名称。

---

## 文档自检

- [x] 测试迁移去向清晰。
- [x] 删除旧智能推断要求。
