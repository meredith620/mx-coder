
  你现在接手 mm-coder (Multi-modal Coder) 的第二阶段实现工作。请严格按照现有设计意图继续开发，不要重新发散架构，不要跳过 TDD，不要自创第二套语义。

  ## 项目目标

  将 mm-coder 的 IM 通信模型从“每条消息启动一次 Claude 进程”迁移为：

  - 每个活跃 IM session 对应一个常驻 Claude 进程
  - 后续消息通过 stdin.write(JSONL) 连续投递
  - 一条消息完成的唯一可靠边界是 Claude 输出流中的 `result` 事件
  - 终端 attach / IM worker / approval / takeover 必须共享同一套状态真值

  ## 你必须先阅读的文件（按顺序）

  1. `docs/SPEC.md`
  2. `docs/IMPL-SLICES.md`
  3. `docs/IMPL-SLICES.resident-worker-tdd.md`
  4. `docs/STATE-INVARIANTS.md`
  5. `docs/EVENT-SEMANTICS.md`
  6. `docs/MATTERMOST-GAPS.md`

  然后再读这些实现入口文件：

  7. `src/daemon.ts`
  8. `src/session-registry.ts`
  9. `src/im-worker-manager.ts`
  10. `src/im-message-dispatcher.ts`
  11. `src/plugins/im/mattermost.ts`
  12. `src/attach.ts`
  13. `src/types.ts`
  14. `src/session-state-machine.ts`
  15. `src/approval-manager.ts`
  16. `src/approval-handler.ts`
  17. `src/plugins/cli/claude-code.ts`

  ## 设计真值与约束

  ### 目标设计真值
  当前目标设计的真值来源是：
  - `docs/SPEC.md`
  - `docs/STATE-INVARIANTS.md`
  - `docs/EVENT-SEMANTICS.md`
  - `docs/IMPL-SLICES.resident-worker-tdd.md`

  当前代码里有一些旧语义残留，代码不是完全真值；你要做的是把代码迁移到文档定义的目标状态。

  ### 绝对不能破坏的原则
  1. 不能有两个 Claude 进程同时驱动同一个 sessionId
  2. 不能再把“子进程退出”当作一条消息完成边界
  3. `approval_pending` 是当前活动消息的阻塞子状态，不是独立全局态
  4. `messageQueue` 只是调度队列，不是“一条消息一个进程”的生命周期容器
  5. daemon 重启后不能把旧的 ready worker 当作可继续控制的真实进程
  6. busy/idle 只能由 mm-coder 基于事件流外推，Claude Code 没有状态查询 API
  7. typing indicator 不是 Claude 原生状态，只能作为 `runtimeState=running` 的派生行为

  ## 当前实现中你需要特别警惕的老问题

  ### 老路径残留
  - 生产路径里可能还残留 `buildIMMessageCommand()` 的依赖
  - 任何“spawn 一个临时 Claude 来处理单条 IM 消息”的生产逻辑都要迁移掉

  ### 事件名双真值风险
  当前实现中可能存在：
  - `attach_ready`
  - `session_resume`

  你必须统一 attach waiter 的唯一事件名，CLI 和 daemon 只能使用一个真值事件协议。

  ### Mattermost 长连接风险
  当前 `src/plugins/im/mattermost.ts` 只有基础 open/close/reconnect，还没有完整的应用层活性检测。
  必须按设计补上：
  - `lastWsMessageAt`
  - `lastHeartbeatSentAt`
  - `lastHeartbeatAckAt`
  - 半断链识别
  - 主动 close + reconnect
  - REST 健康与 WS 活性分离

  ## 执行方式：严格按 TDD slices 顺序推进

  只允许按 `docs/IMPL-SLICES.resident-worker-tdd.md` 中的顺序推进：

  - R1
  - R2
  - R3
  - R4
  - R5
  - R6
  - R7
  - R8
  - R9
  - R10
  - R11
  - R12

  不要跳切片，不要并行推进多个切片，不要把几个切片揉成一个大改动。

  ## 每个切片的执行规范

  对每个切片，严格遵守以下流程：

  1. 先确认前置依赖切片已经完成
  2. 先写测试，且测试应先失败
  3. 再写最小实现让该切片测试通过
  4. 不顺手做无关重构
  5. 运行该切片对应测试
  6. 如果该切片涉及状态、事件名、恢复语义，先 grep 代码确认没有旧真值残留
  7. 完成后给出简洁总结，再继续下一个切片

  ## 每次汇报必须包含

  每完成一个切片，汇报必须固定包含：

  1. 本次完成的切片编号
  2. 新增/修改了哪些测试
  3. 修改了哪些实现文件
  4. 还遗留了什么未解决风险
  5. 本切片对应测试是否通过
  6. 是否发现设计文档与代码存在冲突
  7. 下一步将进入哪个切片

  ## 不要做的事

  - 不要重新设计架构
  - 不要创建新的“分析文档”或“大型说明文档”
  - 不要绕开 `STATE-INVARIANTS` 和 `EVENT-SEMANTICS`
  - 不要把旧的单轮语义偷偷保留成 fallback
  - 不要在未统一事件协议前继续扩 attach 流程
  - 不要在未补 WS 活性检测前宣称 Mattermost 长连已经可靠
  - 不要在 `waiting_approval` / `ready` / `cold` / `recovering` 下发送 typing

  ## 如果你发现文档与代码冲突

  按以下优先级处理：

  1. 先判断是不是当前代码的旧残留
  2. 以 `SPEC + STATE-INVARIANTS + EVENT-SEMANTICS + IMPL-SLICES` 作为目标设计真值
  3. 若发现设计文档内部自相矛盾，先停止实现并明确指出冲突点
  4. 不要自己静默决定改语义

  ## 你现在的起始任务

  现在就从 **R1** 开始。
  先做：
  - 类型与 runtimeState 基线迁移
  - 状态机迁移补齐
  - 明确当前代码里旧 runtimeState 枚举与新设计的差距

  开始前先给我一个非常简短的启动说明：
  - 你已读完哪些文件
  - 你准备先改哪个切片
  - 你预期最先会碰到的 1~2 个风险点是什么

  然后立刻进入 TDD 实施。
