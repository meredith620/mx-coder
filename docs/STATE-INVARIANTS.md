# mm-coder (Multi-modal Coder) 状态不变量护栏

> **文档生命周期**：这是常驻 IM worker 架构下的长期护栏文档，不是一次性设计笔记。  
> 当 `Session` 字段、状态机、runtimeState、attach/takeover/approval 语义发生变化时，必须同步更新本文件。若代码与本文件冲突，以“经测试验证后的代码 + 已确认的 SPEC”作为修订依据，然后回写本文件，而不是放任漂移。  
> 适用范围：为 AI agent、代码 reviewer、未来维护者提供“哪些状态组合绝对不应该出现”的统一真值。

---

## 1. 目标

本文件定义 mm-coder 在“每个活跃 IM session 一个常驻 Claude 进程”模型下的**状态不变量**。这些不变量用于：
- 约束实现，避免 `status` / `runtimeState` / pid / queue / approval 互相漂移
- 指导测试，尤其是 unit / integration 中的 invariant tests
- 帮助 agent 在改动前先检查自己是否破坏控制面真值

---

## 2. 核心状态层次

mm-coder 的状态分三层：

1. **控制面状态 `status`**
   - `idle | attach_pending | attached | im_processing | approval_pending | takeover_pending | recovering | error`
   - 作用：表达控制权归属与流程阶段

2. **运行态 `runtimeState`**
   - `cold | ready | running | waiting_approval | attached_terminal | takeover_pending | recovering | error`
   - 作用：表达 Claude worker/terminal 的运行语义

3. **执行补充信息（建议实现层维护）**
   - `activeMessageId?`
   - `pendingApprovalRequestId?`
   - `lastTurnOutcome?`
   - `interruptReason?`
   - `lastResultAt?`

原则：**`status` 决定控制权，`runtimeState` 决定运行语义，补充字段决定最近一次执行结果与来源。**

---

## 3. 强不变量（必须始终成立）

### 3.1 控制权互斥

1. **终端 attach 与 IM worker 不可并存驱动同一 sessionId。**
   - 若 `attachedPid != null`，则不允许存在“仍被视为活跃控制端”的 IM worker。
   - 允许旧 worker 退出中的短暂技术窗口，但在状态提交后不得同时对外宣称二者都可用。

2. **同一 session 任一时刻只有一个有效控制端。**
   - 终端 attach
   - IM 常驻 worker
   - takeover 过渡态
   三者只能三选一。

### 3.2 status 与 runtimeState 对齐关系

3. `status = attached` => `runtimeState = attached_terminal`
4. `status = takeover_pending` => `runtimeState = takeover_pending`
5. `status = approval_pending` => `runtimeState = waiting_approval`
6. `status = recovering` => `runtimeState = recovering`
7. `status = error` => `runtimeState = error`
8. `status = im_processing` => `runtimeState = running`
9. `status = idle` => `runtimeState ∈ {cold, ready}`
10. `status = attach_pending` => `runtimeState ∈ {running, waiting_approval, ready}`
    - `ready` 仅表示“worker 已就绪，但 attach 优先，正在切换前停 worker”

### 3.3 PID 与运行态关系

11. `runtimeState = cold` => `imWorkerPid = null`
12. `runtimeState = ready` => `imWorkerPid != null`
13. `runtimeState = running` => `imWorkerPid != null`
14. `runtimeState = waiting_approval` => `imWorkerPid != null`
15. `runtimeState = attached_terminal` => `attachedPid != null`
16. `runtimeState = recovering` 不要求 `imWorkerPid != null`
    - 因为恢复中可能尚未拉起新 worker
17. `runtimeState = error` 不要求任何 pid 非空

### 3.4 消息执行关系

18. 若 `activeMessageId != null`，则 `runtimeState ∈ {running, waiting_approval}`
19. 若 `runtimeState = running`，则应存在一个“当前轮次”的活动消息上下文
20. 若 `runtimeState = waiting_approval`，则必须存在待决审批上下文
21. `result` 是当前消息完成的唯一可靠提交边界
    - **不是**子进程退出
    - **不是**assistant 文本结束

### 3.5 队列关系

22. `messageQueue` 是调度队列，不是进程生命周期容器
23. 同一 session 任一时刻最多只有一条消息处于 `running` 或 `waiting_approval`
24. `attach_pending` 时队列可入队但不可出队
25. `approval_pending` 时队列冻结，直到审批结束或被取消
26. `attached` / `takeover_pending` 时普通 IM 文本消息默认不入队

### 3.6 恢复关系

27. daemon 重启后，不允许把“旧的 ready worker”当作可继续控制的真实进程
28. 持久化恢复后的 `runtimeState` 不能直接恢复成“可信 ready”，除非新 daemon 已重新验证并重建 worker
29. `approval_pending` 经 daemon 重启后必须 fail-closed（转为 expired 或恢复路径）

---

## 4. 推荐不变量（强烈建议实现）

30. `lastTurnOutcome = completed` 时，若当前不 attached 且无错误，推荐 `runtimeState = ready`
31. `lastTurnOutcome = interrupted` 时，推荐仍落在 `runtimeState = ready`，并通过 `interruptReason` 区分是 takeover / user_cancelled / timeout / crash-recovered
32. `busy/idle` 若对外提供二值派生：
   - busy = `running | waiting_approval | attached_terminal | takeover_pending | recovering`
   - idle = `cold | ready`
   - 但 UI/CLI 详细状态展示不得把 `cold` 与 `ready` 混成同一个状态文案
33. `typing indicator` 若实现：仅允许在 `runtimeState = running` 时发送；`waiting_approval`、`ready`、`cold`、`recovering` 不得发送

---

## 5. 典型非法组合（看到就是 bug）

- `status = attached` 且 `imWorkerPid != null`，并且系统仍宣称 IM worker 可接收消息
- `status = idle` 且 `runtimeState = running`
- `status = approval_pending` 且没有任何 pending approval request
- `runtimeState = cold` 但 `imWorkerPid != null`
- `runtimeState = ready` 但 worker 实际已死、且尚未重新验证
- 队列里两条消息同时为 `running`
- attach waiter 在等 `attach_ready`，daemon 却只发 `session_resume`，或反之

---

## 6. 测试建议

至少应有以下 invariant tests：

1. `status -> runtimeState` 映射测试
2. pid 与 runtimeState 关系测试
3. 同 session 只允许一个活动消息测试
4. attach / takeover 切换时不会出现双控制端测试
5. daemon 重启后不会错误恢复 ready worker 测试
6. 事件名统一性测试（attach waiter 协议）

---

## 7. 维护规则

当以下任一内容发生变化时，必须同步更新本文件：
- `src/types.ts` 中 Session / RuntimeState / SessionStatus 定义
- `src/session-state-machine.ts` 迁移规则
- `src/session-registry.ts` 的状态提交逻辑
- `src/im-worker-manager.ts` 的 pid / restart / ensureRunning 语义
- `src/attach.ts` 与 daemon 间等待事件协议
- `docs/SPEC.md` 中状态机、runtimeState、恢复策略章节

如果未来发现某个不变量无法成立，应执行三步：
1. 先确认是文档错了还是实现错了
2. 用测试固定新的真值
3. 再修改本文件，附带原因
