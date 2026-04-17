# mm-coder (Multi-modal Coder) 实现切片清单（常驻 IM worker / TDD）

> 面向 AI agent 执行。每个切片必须遵循：先补测试，再做最小实现，再跑对应测试，再提交。  
> 本文对应的新架构前提：**每个活跃 IM session 一个常驻 Claude 进程，后续消息通过 stdin.write(JSONL) 连续投递；消息完成边界以 `result` 事件为准。**

旧版切片文档已归档为：`docs/IMPL-SLICES.single-round-foundation.archive.md`

---

## 适用范围与前置假设

本切片文档只描述**从当前 main 分支的“单轮 foundation + 部分常驻 worker 骨架”迁移到完整常驻 IM worker 模型**所需的增量工作，**不是**从零重建整个项目。

开始执行前，AI agent 必须先阅读：
- `AGENTS.md`
- `docs/SPEC.md`
- `docs/IMPL-SLICES.md`
- `src/daemon.ts`
- `src/im-worker-manager.ts`
- `src/im-message-dispatcher.ts`
- `src/session-registry.ts`
- `src/approval-manager.ts`
- `src/approval-handler.ts`
- `src/plugins/cli/claude-code.ts`

---

## 执行总原则

1. **不要跨切片偷改。** 每个切片必须是可独立提交、可回滚的最小单元。
2. **先红后绿。** 先写失败测试，再补实现。
3. **以事件边界而不是进程退出作为真值。** 常驻 worker 下，`result` 才是一条消息完成的提交点。
4. **控制权切换优先于吞吐。** attach/takeover 时，必须先保证不会有两个 Claude 进程同时驱动同一 session。
5. **busy/idle 只能外部推断。** Claude Code 没有状态查询 API，状态必须由 mm-coder 基于事件流维护。

---

## Phase A：类型与状态语义重构

### R1 — runtimeState / busy-idle 类型基线
**目标**：先把类型系统和状态语义改到位，避免后面边改边漂移。  
**依赖**：无

**先写测试**
- `tests/unit/types.test.ts`
- `tests/unit/session-state-machine.test.ts`

**测试关注点**
- `runtimeState` 新枚举：`cold | ready | running | waiting_approval | attached_terminal | takeover_pending | recovering | error`
- `status` 与 `runtimeState` 不再一一映射
- 新增/修正状态迁移：
  - `approval_pending + attach_start -> attach_pending`
  - `approval_pending + worker_crash -> recovering`

**后写实现**
- `src/types.ts`
- `src/session-state-machine.ts`
- `src/persistence.ts` 中 runtimeState 恢复映射先做占位调整

**验收**
- `npm test -- types`
- `npm test -- session-state-machine`

**提交建议**
- `refactor(state): redefine runtimeState for resident IM worker model`

---

### R2 — SessionRegistry 忙闲语义与控制面解耦
**目标**：让 SessionRegistry 成为唯一真值层，表达“控制权状态 + 运行语义 + 当前消息执行态”。  
**依赖**：R1

**先写测试**
- `tests/unit/session-registry.test.ts`

**测试关注点**
- 创建 session 后默认：`status=idle`，`runtimeState=cold`
- worker 已就绪但未执行消息：`status=idle`，`runtimeState=ready`
- 当前消息处理中：`status=im_processing`，`runtimeState=running`
- 工具审批中：`status=approval_pending`，`runtimeState=waiting_approval`
- attach 中：`status=attached`，`runtimeState=attached_terminal`
- attach_pending 时若 worker 仅 ready，可直接切 attach；若 running/waiting_approval，必须冻结队列并等待安全切换

**后写实现**
- `src/session-registry.ts`
- 如有必要新增 session 内辅助字段：例如 `activeMessageId` / `pendingApprovalRequestId` / `lastResultAt`

**验收**
- `npm test -- session-registry`

**提交建议**
- `refactor(registry): separate control status from worker runtime state`

---

## Phase B：CLI 插件与常驻 worker 基线

### R3 — CLIPlugin 切到常驻 worker 契约
**目标**：删除 per-message 启动抽象，让插件契约只服务于 attach 和常驻 worker。  
**依赖**：R2

**先写测试**
- `tests/unit/claude-code-plugin.test.ts`
- `tests/helpers/mock-cli-plugin.ts`

**测试关注点**
- `buildIMWorkerCommand()` 仍构造 `claude -p --input-format stream-json --output-format stream-json --verbose`
- `buildIMMessageCommand()` 从主路径退役：要么删除，要么只保留兼容壳且不再被 dispatcher/daemon 使用
- 所有 mock 插件与测试辅助统一到常驻 worker 契约

**后写实现**
- `src/plugins/types.ts`
- `src/plugins/cli/claude-code.ts`
- 测试辅助 mock plugin
- 全局替换调用点，确保不再有生产路径依赖 `buildIMMessageCommand()`

**验收**
- `npm test -- claude-code-plugin`

**提交建议**
- `refactor(plugin): remove per-message cli command path for IM mode`

---

### R4 — IMWorkerManager 变成真正常驻进程管理器
**目标**：把 `spawn / ensureRunning / sendMessage / terminate / restart` 做实，且 generation 去重可靠。  
**依赖**：R3

**先写测试**
- `tests/unit/im-worker-manager.test.ts`
- `tests/integration/message-delivery.test.ts`

**测试关注点**
- `ensureRunning()` 懒启动成功
- `sendMessage()` 向已存在 worker 的 stdin 写 JSONL，不重复 spawn
- `onDetach()` pre-warm 后 worker 进入 ready，而不是仅有 pid
- attach 前 terminate 会清理 pid 与内部 map
- `spawnGeneration` 并发下只有一个活 worker
- 崩溃重启不会误注册 stale worker
- worker 崩溃后恢复到 `cold/recovering/ready` 的状态映射与持久化语义一致

**后写实现**
- `src/im-worker-manager.ts`

**验收**
- `npm test -- im-worker-manager`
- `npm test -- message-delivery`

**提交建议**
- `feat(im-worker): manage resident claude process lifecycle per session`

---

## Phase C：消息完成边界与流解析

### R5 — 以 `result` 事件作为消息完成边界
**目标**：dispatcher 不再等待进程退出；而是对常驻 stdout 流按“消息开始/消息完成”做切片。  
**依赖**：R4

**先写测试**
- `tests/unit/parse-stream.test.ts` 或现有流解析测试
- `tests/unit/stream-to-im.test.ts`
- 新增 `tests/unit/im-worker-session-stream.test.ts`（建议）

**测试关注点**
- 一条消息的完成由 `result` 事件触发
- `assistant` token 流会持续追加到同一 live message
- 第二条消息开始时不会串到第一条消息的缓冲区
- worker 不退出时也能连续处理多轮消息
- 若存在 `tool_use` / `tool_result` / `system` / `attachment` / `last-prompt` / `queue-operation`，解析器不会因未知或跨轮事件而错乱
- 必须明确“当前轮次”的关联键，至少验证 `messageId` 或等价 turn 上下文可用于分隔多轮流式输出

**后写实现**
- `src/plugins/cli/claude-code.ts` 中 parseStream
- `src/stream-to-im.ts`
- 视需要新增“每 session 的 stdout demux/collector”

**验收**
- `npm test -- stream-to-im`
- `npm test -- parse-stream`

**提交建议**
- `feat(stream): treat result event as message completion boundary`

---

### R6 — IMMessageDispatcher 从“每条消息 spawn”切到“队列驱动常驻 worker”
**目标**：dispatcher 负责队列调度，不再负责创建临时 Claude 进程。  
**依赖**：R5

**先写测试**
- `tests/integration/im-routing.test.ts`
- `tests/integration/message-delivery.test.ts`
- `tests/e2e/im-message-flow.test.ts`（若已有则重写）

**测试关注点**
- 同一 session 多条消息 FIFO 串行写入同一个 worker
- 前一条未收到 `result` 前，后一条不能出队
- `approval_pending` 时队列冻结
- attach_pending 时队列冻结
- attached / takeover_pending 时普通 IM 文本被拒绝
- dispatcher 与 IMWorkerManager 的职责边界清晰：dispatcher 只做“何时发下一条”，worker manager 只做“确保进程存在并写 stdin”

**后写实现**
- `src/im-message-dispatcher.ts`
- `src/daemon.ts` 中与 dispatcher 的连接方式
- 删除或迁移所有“spawn 一个临时 Claude 处理单条消息”的生产代码路径

**验收**
- `npm test -- im-routing`
- `npm test -- message-delivery`

**提交建议**
- `feat(dispatcher): drive resident IM worker from per-session FIFO queue`

---

## Phase D：attach / takeover / approval 的安全切换

### R7 — attach 与 IM worker 的安全切换
**目标**：attach 前停 worker；running / waiting_approval 时进入 attach_pending；ready 时直接切。  
**依赖**：R6

**先写测试**
- `tests/integration/daemon-attach.test.ts`
- `tests/integration/attach-flow.test.ts`
- `tests/e2e/attach-im-switch.test.ts`

**测试关注点**
- `runtimeState=ready` 时 attach 不等待，先停 worker 再 attach
- `runtimeState=running` 时 attach 进入 `attach_pending`，等待当前消息 `result`
- `runtimeState=waiting_approval` 时 attach 不能直接抢占，必须先审批完成或取消
- attach 退出后会 pre-warm worker，回到 `ready`
- attach 与 IM worker 永不并存
- `attach_ready` / `session_resume` 事件名必须统一，切片实施前先决定唯一真值，避免 CLI 与 daemon 各自监听不同事件名

**后写实现**
- `src/daemon.ts`
- `src/attach.ts`
- `src/session-registry.ts`
- `src/im-worker-manager.ts`
- 统一 IPC server-push 事件名与 attach waiter 协议

**验收**
- `npm test -- daemon-attach`
- `npm test -- attach-flow`
- `npm test -- attach-im-switch`

**提交建议**
- `feat(attach): hand off control safely between terminal and resident IM worker`

---

### R8 — takeover 与 approval_pending 的优先级闭环
**目标**：接管时正确取消审批、释放 worker、恢复 IM 控制。  
**依赖**：R7

**先写测试**
- `tests/unit/approval-manager.test.ts`
- `tests/integration/im-routing.test.ts`
- `tests/integration/daemon-commands.test.ts`

**测试关注点**
- `approval_pending + takeover`：先 cancel approval，再进入 takeover 流
- `takeover-force`：终止 attach Claude 进程后，session 回到可由 IM 接手的状态
- scope=session 缓存失效条件：session 结束、takeover 完成、manual_reset、remove
- 强制接管后若 IM worker 已不存在，应由 daemon 负责进入 `cold` 或直接 pre-warm/ensureRunning，不能假设旧 worker 仍可复用

**后写实现**
- `src/approval-manager.ts`
- `src/daemon.ts`
- `src/session-registry.ts`

**验收**
- `npm test -- approval-manager`
- `npm test -- daemon-commands`
- `npm test -- im-routing`

**提交建议**
- `feat(takeover): cancel pending approvals before IM control handoff`

---

## Phase E：恢复、可观测性、连接健壮性与 busy/idle 统一输出

### R9 — 崩溃恢复与 daemon 重启语义
**目标**：常驻 worker 崩溃、daemon 重启、消息恢复矩阵全部和新架构一致。  
**依赖**：R8

**先写测试**
- `tests/integration/persistence.test.ts`
- `tests/integration/message-delivery.test.ts`
- 视需要新增 `tests/integration/recovery.test.ts`

**测试关注点**
- daemon 重启后旧 worker 不恢复，session 回到 `cold` 或 `recovering`
- `running` 消息 → `confirm`
- `pending` 消息 → `replay/confirm/discard` 按矩阵决策
- `approval_pending` 重启后 → `expired`
- `ready` 不是持久化出的可靠进程状态；即使持久化前是 ready，重启后也必须回到 `cold` 或恢复路径

**后写实现**
- `src/persistence.ts`
- `src/im-worker-manager.ts`
- `src/daemon.ts`
- `src/restore-action.ts`

**验收**
- `npm test -- persistence`
- `npm test -- recovery`

**提交建议**
- `feat(recovery): align restart and replay semantics with resident worker model`

---

### R10 — Mattermost WebSocket 活性与重连自愈
**目标**：识别“TCP 看似恢复但 WS 订阅逻辑已失活”的半断链场景，并能主动自愈。  
**依赖**：R9

**先写测试**
- `tests/unit/mattermost-plugin.test.ts`
- 视需要新增 `tests/integration/mattermost-ws-resilience.test.ts`

**测试关注点**
- 仅 `open` 事件不能视为连接健康
- 若超过 heartbeat/活性窗口未收到 WS 消息或 ack，会主动 close 并重连
- REST 正常但 WS 无事件时，不得把插件判定为完全健康
- 重连后旧连接状态会被清理，不会重复分发消息

**后写实现**
- `src/plugins/im/mattermost.ts`
- 如有必要补充配置字段与内部活性时间戳

**验收**
- `npm test -- mattermost-plugin`
- `npm test -- mattermost-ws-resilience`

**提交建议**
- `feat(mattermost): add websocket liveness detection and self-healing reconnect`

---

### R11 — busy/idle 状态对外呈现与 typing indicator
**目标**：CLI / IM / TUI / status 输出统一使用新的 busy-idle 语义，并将 typing indicator 作为 `running` 的派生行为。  
**依赖**：R10

**先写测试**
- `tests/unit/tui-renderer.test.ts`
- `tests/e2e/cli-e2e.test.ts`
- `tests/integration/daemon-commands.test.ts`
- `tests/unit/mattermost-plugin.test.ts`（typing 节流与状态门控）

**测试关注点**
- `status` 输出能区分 `cold / ready / running / waiting_approval / attached_terminal / takeover_pending / recovering / error`
- TUI/IM 状态渲染与内部 runtimeState 一致
- “任务中断等待指令”不会误显示为 running，而应落在 `ready` + `lastExitReason/interruptedReason` 的组合上
- busy/idle 对外若需要二值派生，必须明确派生规则：
  - busy = `running | waiting_approval | attached_terminal | takeover_pending | recovering`
  - idle = `cold | ready`
- typing 仅在 `runtimeState=running` 时按节流发送；`waiting_approval`、`ready`、`cold`、`recovering` 不发送

**后写实现**
- `src/index.ts`
- `src/daemon.ts`
- `src/tui.ts`
- `src/plugins/im/mattermost.ts`
- IM 状态渲染相关代码

**验收**
- `npm test -- cli-e2e`
- `npm test -- tui-renderer`
- `npm test -- daemon-commands`
- `npm test -- mattermost-plugin`

**提交建议**
- `feat(status): expose unified busy-idle state and typing semantics across cli im and tui`

---

## Phase F：文档与总验收

### R12 — 文档与回归闭环
**目标**：实现与文档最终对齐。  
**依赖**：R11

**操作**
- README / SPEC / TODO / 新 IMPL-SLICES 一致性复核
- 回归测试全量执行
- 补遗留设计差异

**验收**
- `npm run build`
- `npm test`

**提交建议**
- `docs(mm-coder): sync resident worker architecture and implementation slices`

---

## 关键边界提醒

### 最容易改坏的 5 个点
1. **把“消息完成”继续错误地绑定到子进程退出。** 这是从单轮模式迁移到常驻模式最容易残留的旧假设。
2. **attach 与 IM worker 并存。** 只要出现双驱动同一 `sessionId`，状态就不可信。
3. **approval_pending 被当成独立状态，而不是运行中消息的阻塞子态。** 这会导致 takeover/attach 时取消语义错乱。
4. **`messageQueue` 继续暗含“一条消息一个 Claude 进程”。** 常驻模式下队列只负责串行调度。
5. **daemon 重启后误认为还能接回旧 worker。** 进程级恢复不可信，必须回到 `cold`/懒启动路径。

### AI agent 执行检查清单
- [ ] 当前切片前置依赖已完成
- [ ] 已先阅读“适用范围与前置假设”列出的文件
- [ ] 测试先写且先失败
- [ ] 不跨切片顺手改 unrelated 代码
- [ ] 每个切片只做最小实现
- [ ] 本切片通过后再提交
- [ ] 本切片若涉及事件名、状态名、恢复语义，先 grep 当前实现确认没有旧真值残留
