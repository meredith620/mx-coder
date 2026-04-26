# mx-coder 稳定化 TDD 切片（P1–P3 未完成项）

> 这份文档是 **当前未完成开发项** 的唯一切片入口，供下游 AI agent 按 TDD 顺序推进。  
> 范围只覆盖 `docs/TODO.md` 中 **尚未实现** 的 P1–P3 项；已完成项不再在这里重复展开，避免形成双真值。  
> 若本文件与 `docs/TODO.md` 冲突：**TODO 负责任务总表，本文件负责实现切片与依赖顺序**。

---

## 1. 目标与边界

本文件覆盖以下未完成内容：

### P1 稳定化主链
> 其中部分能力（如 reaction 审批主路径、stop/restart 进度提示）已存在基础实现；本文件保留它们，是为了收口闭环、补回归测试与统一真值，而不是默认要求重做。

1. 初始化闭环与生命周期约束
2. 会话级并发原子性与裁决
3. 审批状态机与关联链补完
4. ACL 三入口零副作用闭环
5. 恢复/重放/幂等与审计闭环
6. 审批 reaction 主路径与 fallback 完整闭环
7. `recovering` 语义收缩与中断恢复显式化
8. stop/restart 长路径可观测性

### P2 接口补全
1. CLI / IPC / IM 的契约真值对齐
2. 运行态补充字段与 busy/idle 三层模型

### P3 剩余增强
1. 文案/展示层统一采用新的 runtimeState 真值
2. Mattermost 健康摘要接入 daemon status/diagnose/TUI
3. Mattermost WS resilience 独立测试组

---

## 2. 当前实现复核结论（作为切片前提）

以下内容已经在代码中落地，不应再重复立项：

- `initState`、`lifecycleStatus`、`revision`、`spawnGeneration` 基础字段已存在：`src/types.ts`、`src/session-registry.ts`
- `beginInitAndAttach()`、`beginAttach()`、`markAttachedWithRevision()` 已提供部分 P1 骨架：`src/session-registry.ts`
- `spawnGeneration` 防双 worker 已有基础实现：`src/im-worker-manager.ts`
- `dedupeKey` 入队去重、`replayOf` 回放指针已存在基础实现：`src/session-registry.ts`
- `CLIUnknownEvent` 与强类型 `CLIEvent` 已存在：`src/types.ts`、`src/plugins/cli/claude-code.ts`
- reaction 审批主路径、REST fallback、预置 reaction、过滤 bot reaction 已有实现基础：`src/plugins/im/mattermost.ts`、`src/daemon.ts`
- `open` 的单次 `spaceStrategy` override 已实现；`create` 仍未把该参数收口为持久化或运行时真值：`src/index.ts`、`src/daemon.ts`、`src/tui.ts`
- busy/idle 的展示派生已在 CLI/TUI 中存在部分实现：`src/index.ts`、`src/tui.ts`
- `stop/restart` 的阶段进度提示已存在基础实现：`src/index.ts`

因此，本文件只处理这些基础之上的 **闭环缺口、语义不一致和测试空洞**。

---

## 3. 真正未完成的缺口重组

### G1. P1-A 初始化/生命周期闭环仍未完全打通
仍缺：
- `initState=uninitialized` 时 **IM 首条消息** 的 first-writer-wins 懒初始化闭环
- `archived` session 的运行入口拒绝在 daemon / dispatcher / attach 全链路统一收口
- `init_failed` 分支与恢复策略未形成完整可测语义

### G2. P1-B 并发原子性还只有局部骨架，没有全链路保证
仍缺：
- session 锁并未覆盖所有状态变更、队列变更、副作用写入
- `SESSION_BUSY` 与“已经被拒绝/已经入队”的边界还不够稳定
- attach 优先规则在 registry、daemon、dispatcher 间未完全统一
- approval → takeover 取消当前审批的闭环缺少端到端验证

### G3. P1-C 审批链还差协议一致性与 stale 审计
仍缺：
- `ApprovalContext` 与最终决策/审计字段未统一收口到一处真值
- permission prompt tool 返回协议虽已编码，但缺少完整 TDD 切片收口
- first-write-wins / stale discard / session scope cache 命中仍需补系统级验证

### G4. P1-D ACL 仍不是“三入口统一、零副作用”
仍缺：
- `status/open/takeoverStatus/takeoverCancel/import` 等入口未全部按新矩阵鉴权
- CLI IPC 层入口与 IM 文本入口的副作用回滚/零副作用未系统验证
- 审批入口的 allow/deny/ask 约束与 capability/risk 仍缺一致性测试

### G5. P1-E 恢复算法目前只有局部工具，不是完整产品语义
仍缺：
- `restoreAction` 判定矩阵未完整接入 daemon 重启恢复主链
- `discard` / `confirm` / `replay` 用户可见交互未与 messageQueue 恢复完全闭环
- 恢复审计字段最小集未统一
- `recovering` 仍混有“运行时恢复”和“daemon 重启遗留”两种语义

### G6. P2/P3 展示层真值仍未统一
仍缺：
- `status` / IM `/status` / TUI 文案仍混有旧 `status` 术语
- busy/idle 仍主要是派生展示，没有补充执行字段真值（`activeMessageId`、`lastTurnOutcome`、`interruptReason`、`lastResultAt`）
- Mattermost 连接健康虽然插件可读，但还没成为 daemon/status/TUI 的统一诊断面

---

## 4. 执行 gate（先验证，再实现）

在进入任一 slice 前，下游 agent 必须先做一轮“当前实现真值核对”：

1. 先读切片对应代码与测试。
2. 若能力已存在且测试已覆盖，则该 slice 降级为：
   - 回归验证
   - 缺口补测
   - 文档真值修正
3. 只有在“能力缺失或闭环不完整”时，才进入主实现。

尤其以下切片默认先按“已部分实现，先核对再决定是否实现”处理：
- S2.4 reaction 审批主路径
- S4.3 stop/restart 阶段进度提示
- S5.2 Mattermost WS resilience 测试组

> 若 `docs/SPEC.md`、`docs/TODO.md` 与当前实现/测试冲突：**当前实现 + 测试真值优先**，并在完成切片时同步修正文档。

---

## 5. 详细 TDD slices

## S1 — 初始化与并发控制基线

### S1.1 IM 首条消息懒初始化闭环
**目标**：把 first-writer-wins 从 attach 扩展到 IM 首条消息路径。  
**前置依赖**：无。

**先写测试**
- `tests/unit/session-registry.test.ts`
- `tests/integration/daemon-commands.test.ts`
- 视需要新增 `tests/integration/im-init-first-writer.test.ts`

**测试关注点**
- `initState=uninitialized` 时，首条 IM 消息可触发初始化并进入处理
- 并发 attach + IM 到达时，仅一个 writer 获得初始化权
- 另一方收到 `SESSION_BUSY`，且无部分副作用
- `init_failed` 后不会继续走 `--resume`

**后写实现**
- `src/session-registry.ts`
- `src/daemon.ts`
- `src/im-message-dispatcher.ts`
- `src/plugins/cli/claude-code.ts`

**完成判定**
- attach 与 IM 两条路径都遵循同一初始化真值
- 无“已标记 initialized 但本地 Claude session 尚不存在”的错误推进

---

### S1.2 会话级锁 + revision CAS 全链收口
**目标**：确保状态迁移、队列变更、关键副作用都在单 session 原子边界内。  
**前置依赖**：S1.1。

**先写测试**
- `tests/unit/session-registry.test.ts`
- `tests/integration/ipc-subscribe.test.ts`
- 新增 `tests/integration/session-concurrency.test.ts`

**测试关注点**
- attach / enqueue / takeover / worker ready / worker stop 并发时不出现双提交
- `SESSION_BUSY` 与 `ACL_DENIED` 区分明确
- revision 冲突时不出现部分副作用（如状态变了但队列已写）
- attach_pending 期间队列 frozen：可入队不可出队

**后写实现**
- `src/session-registry.ts`
- `src/daemon.ts`
- `src/im-message-dispatcher.ts`
- `src/im-worker-manager.ts`

**完成判定**
- 关键变更点不再绕过锁直接改 Session 对象
- 集成测试能稳定复现并裁决竞态

---

### S1.3 attach / IM / takeover 裁决统一
**目标**：统一 attach 优先、approval→takeover 优先级与 worker 唯一性。  
**前置依赖**：S1.2。

**先写测试**
- `tests/unit/session-registry.test.ts`
- `tests/integration/daemon-commands.test.ts`
- `tests/integration/im-routing.test.ts`

**测试关注点**
- `idle` 下 attach 与 IM 并发时 attach 优先
- `approval_pending` 收到 takeover 时先 cancel approval，再进入 takeover 流
- `attach_pending` 期间 dispatcher 不得继续出队
- pre-warm / lazy spawn / crash restart 竞态下仅一个有效 worker 存活

**后写实现**
- `src/session-registry.ts`
- `src/daemon.ts`
- `src/im-worker-manager.ts`
- `src/im-message-dispatcher.ts`

**完成判定**
- 不再存在“attached 期间旧语义入队执行”残留
- approval 与 takeover 的冲突行为可预测且有测试覆盖

---

## S2 — 审批协议与 ACL 闭环

### S2.1 ApprovalContext / stale / first-write-wins 真值统一
**目标**：让审批上下文、决策、缓存键和 stale 丢弃成为一套真值。  
**前置依赖**：S1.3。

**先写测试**
- `tests/unit/approval-manager.test.ts`
- `tests/unit/approval-handler.test.ts`
- `tests/integration/daemon-commands.test.ts`

**测试关注点**
- `requestId` 与当前 pending 不匹配时 stale 丢弃且不改状态
- 多 approver 并发时 first-write-wins，其余为 stale/cancelled
- `scope=session` 命中键固定为 `sessionId + operatorId + capability`
- session 结束 / takeover / reset 后 session cache 失效

**后写实现**
- `src/approval-manager.ts`
- `src/approval-handler.ts`
- `src/daemon.ts`
- `src/types.ts`

**完成判定**
- ApprovalManager 不再只有“功能上可用”，而是对外暴露一致的协议语义

---

### S2.2 permission prompt tool 协议与 capability/risk 收口
**目标**：把 MCP 输入输出协议、capability 推导、risk 分级做成单一真值。  
**前置依赖**：S2.1。

**先写测试**
- `tests/unit/approval-handler.test.ts`
- `tests/unit/types.test.ts`
- 如有必要新增 `tests/integration/mcp-permission-protocol.test.ts`

**测试关注点**
- 输出必须是单个 text block，text 内容为 JSON 字符串
- `input` 与旧 `tool_input` 兼容，但真值收口到 `input`
- allow 返回 `behavior=allow + updatedInput`
- deny 返回 `behavior=deny + message`
- capability 缺失时由 daemon 做保守推导，不出现不稳定 cache miss

**后写实现**
- `src/approval-handler.ts`
- `src/types.ts`
- `src/approval-manager.ts`

**完成判定**
- 审批协议可独立被测试，不依赖人工对日志目测

---

### S2.3 ACL 三入口零副作用闭环
**目标**：先在 ACL 真值层补齐 action 矩阵与错误码语义，再把 CLI 命令入口、IM 文本入口、审批动作入口统一到同一 ACL 矩阵。  
**前置依赖**：S2.2。

**先写测试**
- `tests/integration/daemon-commands.test.ts`
- `tests/integration/im-routing.test.ts`
- 新增 `tests/integration/acl-entrypoints.test.ts`

**测试关注点**
- 先为 `AclAction` 与入口矩阵补齐真值：`attach/remove/open/takeoverStatus/takeoverCancel/import` 等 CLI 入口都必须有明确动作定义
- `attach/remove/open/takeoverStatus/takeoverCancel/import` 等 CLI 入口按矩阵鉴权
- IM 普通文本/approve/deny/cancel/takeover 等入口无权限时零副作用
- `ACL_DENIED` 不得写入队列、状态或审批决策
- 审批入口的 autoAllow/autoDeny 只命中允许的 capability/risk 组合

**后写实现**
- `src/acl-manager.ts`（先补 action 矩阵与授权真值）
- `src/daemon.ts`
- `src/ipc/socket-server.ts`
- `src/approval-handler.ts`

**完成判定**
- “有无权限” 与 “session 是否忙” 的错误码语义不再混杂

---

### S2.4 reaction 审批主路径回归与补测
**目标**：验证现有 reaction 审批主路径已经满足设计真值，并补足缺失回归。  
**前置依赖**：S2.3。

**先写测试**
- `tests/unit/mattermost-plugin.test.ts`
- `tests/integration/daemon-commands.test.ts`
- 新增 `tests/integration/mattermost-approval-reaction.test.ts`

**测试关注点**
- approval post 自动预置 👍 / ✅ / 👎 / ⏹️
- WS `reaction_added` 为主路径
- WS 丢失时 REST `/posts/{id}/reactions` fallback 能收口
- bot 自身 reaction 被过滤
- `/approve once|session`、`/deny`、`/cancel` 作为 fallback 与 reaction 语义一致

**后写实现**
- `src/plugins/im/mattermost.ts`
- `src/daemon.ts`
- `src/approval-manager.ts`

**完成判定**
- reaction 与文本 fallback 的语义一致，且不会误把 bot reaction 当用户审批

---

## S3 — 恢复/重放/审计闭环

### S3.1 restoreAction 判定矩阵接入恢复主链
**目标**：让 `replay / confirm / discard` 不再只是工具函数，而是实际恢复流程真值。  
**前置依赖**：S2.4。

**先写测试**
- `tests/unit/restore-action.test.ts`
- `tests/integration/persistence.test.ts`
- 新增 `tests/integration/recovery-restore-action.test.ts`

**测试关注点**
- 低风险 + 无审批上下文 → replay
- 带审批上下文 → confirm
- 明确不可恢复 / 高风险 → discard
- replay 时写入 `replayOf`
- 同一 `dedupeKey` 不得重复执行

**后写实现**
- `src/restore-action.ts`
- `src/persistence.ts`
- `src/daemon.ts`
- `src/session-registry.ts`

**完成判定**
- daemon 重启恢复不再只回到模糊状态，而是给出明确恢复动作

---

### S3.2 `recovering` 语义收缩与显式中断恢复
**目标**：把 `recovering` 从持久化长期状态收缩为运行时恢复态。  
**前置依赖**：S3.1。

**先写测试**
- `tests/unit/session-registry.test.ts`
- `tests/integration/persistence.test.ts`
- 新增 `tests/integration/recovery-control-plane.test.ts`

**测试关注点**
- daemon 重启后，原 `attached/im_processing/approval_pending/takeover_pending` 收口到稳定控制面状态
- 恢复原因进入 recovery metadata，而不是长期卡在 `recovering`
- 被中断的消息/审批必须显式 replay / confirm / discard
- 审批中断后 fail-closed，并重新建立审批链

**后写实现**
- `src/session-registry.ts`
- `src/persistence.ts`
- `src/daemon.ts`
- `src/im-message-dispatcher.ts`

**完成判定**
- 不再出现“daemon 重启后永远 stuck in recovering”

---

### S3.3 恢复审计最小字段收口
**目标**：为 replay/confirm/discard、stale approval、takeover cancel approval 建立统一审计字段。  
**前置依赖**：S3.2。

**先写测试**
- 新增 `tests/integration/recovery-audit.test.ts`
- 如需新增轻量 logger fake，可放在 `tests/helpers/`

**测试关注点**
- 审计字段至少包含 `dedupeKey / replayOf / requestId / operatorId / action / result`
- stale approval 与 cancel-for-takeover 也有审计记录
- 缺字段时测试失败

**后写实现**
- `src/daemon.ts`
- `src/approval-manager.ts`
- `src/session-registry.ts`
- 必要时新增轻量 audit util

**完成判定**
- 恢复和审批仲裁都有可追踪最小审计集

---

## S4 — 运行态真值与展示统一

### S4.1 busy/idle 三层模型落地
**目标**：让 `status`、`runtimeState`、执行补充字段各司其职。  
**前置依赖**：S3.3。

**先写测试**
- `tests/unit/types.test.ts`
- `tests/unit/tui-renderer.test.ts`
- `tests/e2e/cli-e2e.test.ts`

**测试关注点**
- Session 补充字段：`activeMessageId`、`lastTurnOutcome`、`interruptReason`、`lastResultAt`
- busy/idle 派生统一为：
  - busy = `running | waiting_approval | attached_terminal | takeover_pending | recovering`
  - idle = `cold | ready`
- CLI status / TUI / IM status 展示一致

**后写实现**
- `src/types.ts`
- `src/session-registry.ts`
- `src/im-message-dispatcher.ts`
- `src/index.ts`
- `src/tui.ts`
- `src/daemon.ts`

**完成判定**
- “当前在忙什么” 不再只能靠 status 猜测

---

### S4.2 runtimeState 文案统一
**目标**：统一 CLI / IM / TUI 的对外文案语义。  
**前置依赖**：S4.1。

**先写测试**
- `tests/e2e/cli-e2e.test.ts`
- `tests/unit/tui-renderer.test.ts`
- `tests/integration/im-routing.test.ts`

**测试关注点**
- `cold / ready / running / waiting_approval / attached_terminal / takeover_pending / recovering / error` 在三处展示统一
- 不再向用户暴露旧 status 术语作为运行态语义

**后写实现**
- `src/index.ts`
- `src/tui.ts`
- `src/daemon.ts`

**完成判定**
- 用户看到的状态文案与 SPEC 运行态术语完全一致

---

### S4.3 stop/restart 长路径进度提示回归
**目标**：确认现有控制面可观测性实现与文案真值一致，并补足缺失测试。  
**前置依赖**：S4.2。

**先写测试**
- `tests/e2e/cli-e2e.test.ts`
- 如需要新增 `tests/e2e/cli-restart-progress.test.ts`

**测试关注点**
- stop/restart 输出阶段性提示：`stopping / waiting graceful shutdown / waiting socket release / starting`
- 失败时提示停在什么阶段

**后写实现**
- `src/index.ts`

**完成判定**
- 长路径命令不再被误判为卡死

---

## S5 — Mattermost 诊断与 resilience 增强

### S5.1 健康摘要接入 daemon status/diagnose/TUI
**目标**：把 Mattermost 健康从插件内部字段提升为外显诊断面。  
**前置依赖**：S4.3。

**先写测试**
- `tests/unit/tui-renderer.test.ts`
- `tests/e2e/cli-e2e.test.ts`
- 新增 `tests/integration/mattermost-health-diagnose.test.ts`

**测试关注点**
- status / diagnose / TUI 可显示 REST healthy、WS healthy、subscription healthy
- 无 IM 插件时表现稳定，不崩溃
- channel/thread 两种绑定场景都能展示

**后写实现**
- `src/plugins/im/mattermost.ts`
- `src/daemon.ts`
- `src/index.ts`
- `src/tui.ts`

**完成判定**
- 长连问题可从 daemon 诊断面直接观察

---

### S5.2 `mattermost-ws-resilience` 独立测试组
**目标**：把目前零散的 WS 健壮性测试收拢为专门测试组，并仅在测试暴露缺口时做最小实现修补。  
**前置依赖**：S5.1。

**先写测试**
- 新增 `tests/integration/mattermost-ws-resilience.test.ts`

**测试关注点**
- heartbeat 超时后主动 close + reconnect
- 旧连接状态清理
- 断链/恢复前后健康字段变化
- reaction 审批 fallback 在 WS 丢失场景仍能收口

**后写实现**
- 若测试暴露缺口，再最小修改：
  - `src/plugins/im/mattermost.ts`
  - `src/daemon.ts`

**完成判定**
- Mattermost 长连接回归保护不再碎片化

---

## 6. 与 TODO 的映射

### P1 对应
- 初始化/生命周期：S1.1
- 锁/CAS/attach 优先/spawnGeneration/takeover 优先级：S1.2、S1.3
- ApprovalContext / stale / first-write-wins / session scope：S2.1、S2.2
- ACL 三入口：S2.3
- dedupe / replay / replayOf / audit：S3.1、S3.3
- reaction 主路径 / fallback / bot 过滤 / 预置 reaction：S2.4
- recovering 语义收缩 / 中断恢复显式化：S3.2
- stop/restart 进度提示：S4.3

### P2 对应
- 契约补全：S2.1、S2.2、S2.3
- busy/idle 三层模型：S4.1

### P3 对应
- runtimeState 文案统一：S4.2
- 健康摘要接入：S5.1
- WS resilience 测试组：S5.2

---

## 7. 执行规则（给下游 agent）

1. 必须严格按切片顺序推进，不要跳 slice。
2. 每个 slice 必须先写失败测试，再写最小实现。
3. 一个 slice 未收口前，不要并行做下一个 slice。
4. 若发现 `docs/TODO.md` 与本文件顺序冲突：以本文件依赖顺序为准，但不得改变 TODO 的任务范围。
5. 完成某个 slice 后，应同步回看：
   - `docs/TODO.md`
   - `docs/SPEC.md`
   - `docs/STATE-INVARIANTS.md`
   - `docs/EVENT-SEMANTICS.md`

---

## 8. 建议测试命令

每个 slice 至少跑其对应测试；阶段性收口建议补跑：

```bash
npm test
npm run build
```

对高风险切片（S1/S2/S3），建议额外补跑：

```bash
npx vitest run tests/unit/session-registry.test.ts tests/unit/approval-manager.test.ts tests/unit/approval-handler.test.ts tests/integration/daemon-commands.test.ts tests/integration/im-routing.test.ts tests/integration/persistence.test.ts
```
