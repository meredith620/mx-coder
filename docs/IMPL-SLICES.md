# mx-coder 实现切片入口

> 当前有效实现切片已拆分为两类：  
> - **主线未完成项稳定化**：`docs/IMPL-SLICES.p1-p3-stabilization.md`  
> - **本轮 v2.1 新需求**：`docs/IMPL-SLICES.v2.1.md`  
> 历史 phase2/phase3 规划文档已降级为参考材料，不再作为当前开发真值入口。

在开始实现前，建议先阅读状态与事件护栏文档：`docs/STATE-INVARIANTS.md`、`docs/EVENT-SEMANTICS.md`。

## 当前执行入口

1. [`IMPL-SLICES.p1-p3-stabilization.md`](./IMPL-SLICES.p1-p3-stabilization.md) — P1–P3 未完成项稳定化切片
2. [`IMPL-SLICES.v2.1.md`](./IMPL-SLICES.v2.1.md) — v2.1 新需求切片

## 对应下游 agent 指令

1. [`AGENT-INSTRUCTIONS.p1-p3-stabilization.md`](./AGENT-INSTRUCTIONS.p1-p3-stabilization.md)
2. [`AGENT-INSTRUCTIONS.v2.1.md`](./AGENT-INSTRUCTIONS.v2.1.md)

## 历史参考

- `docs/archive/IMPL-SLICES.resident-worker-tdd.archive.md`
- `docs/archive/IMPL-SLICES.single-round-foundation.archive.md`
- 其他历史 review / agent 指令见 `docs/archive/`
