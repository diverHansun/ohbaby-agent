# tokenCounting 模块架构设计

## 当前状态

当前源码并没有落成文档早期版本里的完整 `tokenCounting/` 子目录。实际代码状态是：

```text
src/services/llm-model/
└── tokenCalculation.ts
```

其中当前文件仍是占位状态，`types.ts`、`tokenLimits.ts`、`index.ts` 与测试文件尚未落地。

## 当前架构含义

这意味着本模块目前还不能视为一个完整、稳定的可复用服务层；文档目录 `docs/services/llm-model/tokenCounting/` 现在承担的是“需求与设计分组”的角色，而不是源码镜像。

## 当前文件布局

```text
src/services/llm-model/
└── tokenCalculation.ts   # 当前唯一文件，占位中
```

## 演进建议

当 tokenCounting 真正开始实现时，再从当前占位文件演进为：

```text
src/services/llm-model/tokenCounting/
├── types.ts
├── tokenCalculation.ts
├── tokenLimits.ts
└── index.ts
```

在那之前，本架构文档应以“当前源码仍未完成拆分”为准，而不是把目标目录当作已实现现实。
