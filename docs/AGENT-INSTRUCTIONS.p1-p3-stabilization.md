# 给下游 Claude Code agent 的执行指令（P1–P3 稳定化）

你现在接手的是 mx-coder 当前主线的 **稳定化开发**，目标不是扩展功能面，而是把已确认的未完成项收口成可交付真值。

## 主入口

先读：
1. `docs/IMPL-SLICES.p1-p3-stabilization.md`
2. `docs/SPEC.md`
3. `docs/TODO.md`
4. `docs/STATE-INVARIANTS.md`
5. `docs/EVENT-SEMANTICS.md`

必要时再读：
6. `docs/MATTERMOST-GAPS.md`
7. `docs/archive/IMPL-SLICES.resident-worker-tdd.archive.md`
8. `docs/archive/REVIEW.phase2-and-current-state.archive.md`

然后再读代码：
- `src/session-registry.ts`
- `src/daemon.ts`
- `src/im-message-dispatcher.ts`
- `src/im-worker-manager.ts`
- `src/approval-manager.ts`
- `src/approval-handler.ts`
- `src/acl-manager.ts`
- `src/ipc/socket-server.ts`
- `src/restore-action.ts`
- `src/plugins/im/mattermost.ts`
- `src/index.ts`
- `src/tui.ts`
- `src/persistence.ts`
- `src/types.ts`

---

## 你的工作目标

严格按 `docs/IMPL-SLICES.p1-p3-stabilization.md` 中的顺序推进：

1. S1 初始化与并发控制基线
2. S2 审批协议与 ACL 闭环
3. S3 恢复/重放/审计闭环
4. S4 运行态真值与展示统一
5. S5 Mattermost 诊断与 resilience 增强

这是依赖顺序，不得打乱。**但在每个 slice 开始前，必须先核对当前代码与测试；已满足者应降级为回归验证/补测试，而不是重复实现。**

---

## 强约束

1. 必须按 TDD 执行：先失败测试，再最小实现。
2. 不要顺手重构无关模块。
3. 不要在单个回合并行推进多个大 slice。
4. 不要重新发散架构；若发现 SPEC 真值不足，只能提出冲突，不要私自改大方向。
5. 不要把“已有部分实现”误判成“已收口”；本轮目标是闭环与一致性，不是补注释。
6. 改完任何会影响状态语义、审批语义、恢复语义的代码后，必须回看相关文档是否仍准确。

---

## 每个 slice 的执行流程

对每个 slice，必须严格执行：
1. 先确认前置 slice 已完成。
2. 先新增或修改失败测试。
3. 再写最小实现。
4. 运行该 slice 对应测试。
5. 若通过，再决定是否进入下一 slice。

---

## 每次汇报格式

每次汇报必须包含：

- 已读文档：
- 当前切片：
- 新增/修改测试：
- 修改实现文件：
- 当前测试结果：
- 是否发现设计冲突：
- 下一步计划：

保持简短，不要写泛泛总结。

---

## 开始时的首条回复格式

请先只回复：

- 已读文档：
- 当前切片：
- 预期风险：

然后立刻开始实现当前 slice。