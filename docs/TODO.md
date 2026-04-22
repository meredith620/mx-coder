# TODO

mm-coder (Multi-modal Coder) 的 review 产出待解决问题，按优先级排列。

> 未完成项按 P1 → P2 → P3 处理；其中 P1 为实现前阻塞项。

---

## P0: 技术假设验证（Spike）

在写代码前必须验证，任何一个不成立都需要调整方案。

- [x] **`-p` 模式与交互模式 session 兼容性** — 已验证：`claude --resume <id>` 和 `claude -p --resume <id> --input-format stream-json --output-format stream-json --verbose` 交替使用共享同一会话上下文；`--input-format stream-json` 使进程长驻接受多条消息；审批链路选型见下一项（最终采用 MCP PermissionRequest）
- [x] **Claude Code 双审批方案对比** — 对比 `--permission-prompt-tool + MCP server` 与 `PreToolUse Hook`，验证二者在 `-p --resume` 场景下的稳定性、超时行为、实现复杂度和恢复语义
  - **结论**：仅采用 PermissionRequest（MCP）机制，PreToolUse 不引入
  - 实测确认：PreToolUse 同步拦截无法等待 IM 异步响应；PermissionRequest 的 `sendRequest` 返回 Promise 支持 IM 用户审批
  - daemon 充当 MCP server，IM worker 通过 `--permission-prompt-tool mm-coder-permission` 连接
  - autoAllow/autoDeny 在 daemon MCP server 层实现，命中规则时同步返回
- [x] **长 session 的 context window 行为** — 验证 `-p --resume` 加载长历史 session 时，Claude Code 如何处理 context window 溢出
  - **结论**：Claude Code 内部自动管理 context，API inputTokens 稳定在 ~68k 不随 session 累积增长；历史被自动摘要压缩，200k 窗口从不被触发
  - **实测**：session 累积到 ~186k tokens 时 inputTokens 仍为 68,538，cacheReadInputTokens 稳定在 ~118k；5 轮连续 resume 后 inputTokens 仅增至 68,863
  - **设计含义**：mm-coder 无需实现任何 context window 管理逻辑；IM worker 长驻进程不会因 history 累积导致 API 调用失败
- [x] **SIGTERM 接管后的恢复性** — SIGTERM 退出码 143，进程干净终止；Resume 后模型重新规划，不保留中断前 partial 状态知识；Write/Read 等工具中断后 resume 会重新验证并修复，无数据不一致；session 完整性可靠
  - **设计含义**：daemon 向终端 Claude Code 发 SIGTERM 后可立即 pre-warm 新的 IM worker；模型接管后重新规划，可能重复执行部分操作（无数据损坏风险）
- [x] **stream-json 事件结构稳定性** — 已采集 5 个不同测试的 jsonl，覆盖 7 种事件类型（system/assistant/user/result/attachment/last-prompt/queue-operation）
  - **event type 清单**：`system`（init）、`assistant`（含 text/thinking/tool_use block）、`user`（含 tool_result block）、`result`（subtype: success/error）、`attachment`（v2 新增）、`last-prompt`（v2 新增）、`queue-operation`（v2 新增）
  - **tool_use block 结构**：`{type, id, name, input: {...}}`，input 字段依工具而异
  - **tool_result block 结构**：`{type, tool_use_id, content, is_error}`，content 为字符串
  - **thinking block**：含 `thinking` 和 `signature` 字段（v2 新增）
  - 版本稳定性：v2.0.76 新增了 attachment/last-prompt/queue-operation，parseStream 需兼容处理未知 type

## P1: 架构缺陷（实现前阻塞）

> 以下为本次 SPEC 补齐后新增的 P1 项，直接对应 SPEC §3.x 新增约束。全部 P1 完成后方可进入大规模实现。

### 会话初始化与状态闭环（SPEC §3.2 / §9）

- [ ] **initState 懒初始化闭环**：在 `initialized` 前禁止 `--resume`，首次 attach/IM 触发懒初始化（first-writer-wins）；其他 writer 返回 `SESSION_BUSY`
  - 对应 SPEC §3.2 `initState` 字段、§3.6.1 first-writer-wins 规则
- [ ] **lifecycleStatus 与 runtimeState 解耦**：两者独立迁移，`archived` session 禁止进入运行态；`initState` 与两者独立演进
  - 对应 SPEC §9 状态关系说明

### 并发原子性与竞态裁决（SPEC §3.6.1）

- [ ] **会话级锁 + revision CAS**：所有 session 状态变更在单 session 锁内执行；提交时基于 `revision` CAS；冲突返回 `SESSION_BUSY`
  - 对应 SPEC §3.6.1 "原子机制" 小节
- [ ] **attach 优先于 IM**：`idle` 下并发到达时 attach 优先；attached/takeover_pending 时 IM 普通消息默认直接拒绝；`attach_pending` 期间队列冻结；不得继续保留旧的“attached 期间默认入队”语义
  - 对应 SPEC §3.6.1 attach 优先与 §3.9 当前常驻 worker 语义
- [ ] **spawnGeneration 防重**：pre-warm 与 lazy spawn 使用 `spawnGeneration` 防双 worker；`imWorkerPid` 唯一性由 generation 保证
  - 对应 SPEC §3.6.1 "worker 唯一性" 小节
- [ ] **approval → takeover 优先级**：approval_pending 收到 takeover 时，先 cancel approval 再进入 takeover 流
  - 对应 SPEC §3.6.1 "approval→takeover 优先级" 规则

### 审批关联链路与仲裁协议（SPEC §3.4 / §6.3）

- [ ] **ApprovalContext 关联链**：canUseTool 扩展签名（增加 messageId/correlationId/capability/operatorId）；审批结果必须匹配 requestId，不匹配 → stale 丢弃 + 审计
  - 对应 SPEC §3.4 ApprovalContext 接口
- [ ] **并发审批 first-write-wins**：同一 session 仅允许一个 pending；多 approver 并发时 first-write-wins，其余标记 cancelled/stale
  - 对应 SPEC §3.4 "仲裁规则" 小节
- [ ] **scope=session 粒度落地**：缓存键 = `sessionId + operatorId + capability`；生命周期 = session 结束/接管/reset 时失效
  - 对应 SPEC §6.3；用户已确认按能力复用策略

### ACL 三入口执行闭环（SPEC §6.1 / §6.2）

- [ ] **CLI 命令入口鉴权**：socket server 在派发命令前完成 actor 鉴权；ACL_DENIED 零副作用（不入队、不迁移状态、不更新审批）
  - 对应 SPEC §6.1 入口一
- [ ] **IM 消息入口鉴权**：每条 IncomingMessage 解析为 IMCallbackAction 后鉴权；纯文本消息需 operator 角色；approver+ 扩展操作需 capability 维度检查
  - 对应 SPEC §6.1 入口二
- [ ] **审批动作入口约束**：autoAllow 仅限 read_only+low；autoDeny 仅限 shell_dangerous/network_destructive；其余必须走 requestApproval
  - 对应 SPEC §6.1 入口三
- [ ] **SESSION_BUSY 与 ACL_DENIED 语义隔离**：前者是并发问题（锁冲突），后者是权限问题（零副作用 + 错误码区分）
  - 对应 SPEC §6.2

### 恢复幂等算法（SPEC §3.8 / §3.9）

- [ ] **dedupeKey 去重约束**：入站消息 dedupeKey = `<plugin>:<threadId>:<messageId>`；同一 dedupeKey 不得重复入队与重复执行
  - 对应 SPEC §3.8 dedupeKey 定义、§3.9 去重约束
- [ ] **replay/confirm/discard 判定矩阵**：低风险+无审批+未完成 → replay；高风险或带审批上下文 → confirm；明确拒绝/不可恢复 → discard
  - 对应 SPEC §3.8 恢复决策矩阵
- [ ] **replayOf 指针约束**：restoreAction=replay 时必须写入 replayOf 指针并审计
  - 对应 SPEC §3.8 replay 约束
- [ ] **审计最小字段**：每条恢复审计必须包含 dedupeKey、replayOf、requestId、operatorId、action、result
  - 对应 SPEC §3.8 审计约束

## 原有 P1（部分已check）

### Session 状态模型

- [x] 扩展为显式状态机：`idle | attached | im_processing | approval_pending | takeover_pending | recovering | error`
- [x] 定义合法状态迁移与非法迁移处理规则
- [x] 增加 PID 存活检测，防止 attach / IM 流程崩溃导致 session 卡死（`attachedPid` 和 `imWorkerPid` 双轨检测）
- [x] 定义退出原因模型：`normal | taken_over | cli_crash | recovered`
- [x] 明确 attach 时若 IM 正在执行，终端侧的行为：等待 im_processing 完成后再 attach，界面显示等待提示

### IM Worker 生命周期

- [x] 懒启动策略：daemon 重启后不主动重建 IM worker，首条 IM 消息到来时 spawn，同时向 IM 发送"正在启动 Claude Code，请稍候..."
- [x] Pre-warm 策略：`mm-coder attach` 退出后（session 仍在工作语义中），立即 spawn 新的 IM worker（`claude -p --resume <id> --input-format stream-json --output-format stream-json --verbose`）
- [x] 崩溃重启策略：非正常退出（exit code ≠ 0）才重启；最大重试次数可配置（默认 3 次）；超出后 session → `error` 并通知 IM 用户
- [x] `imWorkerCrashCount` 连续崩溃计数重置规则：成功处理一条消息后清零

### 接管机制

- [x] 定义被接管退出 vs 正常退出的区分方式（daemon 预标记退出原因，attach 退出后查询）
- [x] 评估”软通知 + 宽限期 + 强制终止”的接管流程是否值得引入 — 已在 §3.9 定版：hard（默认）vs soft（graceSeconds=30）两种策略，CLI 和 IM 均可指定
- [x] 确保 `attachedPid` 是 spawn 的直接子进程 PID，避免进程树多层导致 kill 错误进程 — 已在 §3.2 明确：attachedPid 记录 mm-coder attach 进程 PID，kill 前验证 pid 存活

### 安全模型

- [x] IM 端用户鉴权：定义谁能发命令、谁能审批权限请求、谁能接管 session
- [x] 审批状态机：`pending / approved / denied / expired / cancelled`
- [x] 定义 fail-closed 策略：IM 不可达、daemon 崩溃、审批超时默认拒绝
- [x] 定义审批交互协议：`requestId` 生成、动作模型、旧审批失效规则 — 已在 §6 定版：requestId=`<sessionId>:<messageId>:<toolUseId>:<nonce>`，scope once/session，新请求自动 cancel 同 session 旧 pending
- [x] `autoDeny` 字符串匹配仅视为 best-effort，设计能力分类 + 风险等级策略 — 已在 §6 定版：能力分级 read_only/file_write/shell_dangerous/network_destructive，三段配置

### 审批交互与恢复模型（新增约束）

- [ ] **IM 审批改为 reaction 主路径 + 简短 fallback**：主交互改为审批卡片 + reaction（👍 once / ✅ session / 👎 deny / ⏹️ cancel）；文本主语法为 `/approve once|session`、`/deny`、`/cancel`，兼容旧的 `last` 写法
  - **依据**：完整 `requestId` 不应暴露为主交互对象；当前 thread 只允许一个 pending approval，因此 `last` 只是冗余语义，简短命令更符合 Mattermost 输入体验
- [ ] **permission prompt tool 协议对齐**：MCP tool 返回必须是单个 text block，text 为 JSON 字符串；allow 返回 `behavior=allow` 且可带 `updatedInput`，deny 返回 `behavior=deny` 且带 `message`；输入字段统一收口到 `input`（兼容旧 `tool_input`）
  - **依据**：Claude Code `--permission-prompt-tool` 的社区验证协议与 claude-threads 实现都要求 text block 中承载结构化 JSON，而非裸 allow/deny 或 `{allow:true}`
- [ ] **for-session 缓存命中修复**：保持 `sessionId + operatorId + capability` 粒度不变，但 `operatorId` 的真值来源收口到 daemon 当前活动消息上下文，`capability` 缺失时由 daemon 基于 `toolName + input` 推导兜底
  - **依据**：88 现场显示 `/approve session` 已成功写入，但后续同 capability 请求仍重复审批，说明 session cache key 中至少有一项（operator/capability）真值来源不稳定
- [ ] **reaction 审批做 WS + REST fallback**：WS 为主，若审批 post 的 reaction 已落库但未收到 WS 事件，则对待决审批 post 轮询 `/posts/{id}/reactions` 收口
  - **依据**：88 现场已确认 reaction 已落库，但 daemon 未收到 `ws_reaction`，不能把审批闭环建立在单一 WS 事件源之上
- [ ] **审批 fallback 过滤 bot 自身 reaction**：REST fallback 必须忽略 bot 预置的 👍 / ✅ / 👎 / ⏹️，只接受非 bot 用户的审批动作
  - **依据**：若把 bot 预置 reaction 当成真实审批，系统会在用户未操作时自动通过，属于审批语义错误
- [ ] **审批消息自动预置 reaction**：approval post 创建后由 bot 主动添加 👍 / ✅ / 👎 / ⏹️ 四个 reaction，降低 Mattermost 手工选 emoji 成本
  - **依据**：用户在 Mattermost 中更自然的操作是直接点击现成 reaction，而不是从符号面板手动搜索；这也是 reaction 主路径可用性的必要组成部分
- [ ] **stop/restart 增加阶段进度提示**：在 CLI 长路径 stop/restart 中持续输出 stopping / waiting graceful shutdown / waiting socket release / starting 等进度提示
  - **依据**：用户在 88 上已多次将长时间等待误判为卡死，可观测性是这条控制面链路的组成部分
- [ ] **`recovering` 语义收缩到运行时恢复，不再作为持久化长期状态**：daemon 重启恢复时，`attached/im_processing/approval_pending/takeover_pending` 应优先回到稳定控制面状态（通常 `idle`），恢复原因落在 recovery metadata
  - **依据**：`recovering` 当前同时承载“运行时 crash 恢复”和“daemon 重启后遗留态”两种语义，会导致 attach/dispatcher 永久卡死
- [ ] **中断消息/审批恢复显式化**：`im_processing` / `approval_pending` 被 daemon 中断后，必须显式 replay / confirm / discard；审批请求需 fail-closed 并重新建立
  - **依据**：恢复语义不能靠 `status=recovering` 隐式表达，否则 pending message 会静默丢失或永远不再被调度

## P2: 接口补全

### 新增接口项（SPEC 补齐后）

- [ ] **CLIEvent 强类型 + unknown 兼容**：parseStream 返回判别联合 `CLISystemEvent | CLIAssistantEvent | CLIUserEvent | CLIResultEvent | CLIAttachmentEvent | CLILastPromptEvent | CLIQueueOpEvent | CLIUnknownEvent`；unknown 类型保留 rawType 不丢弃
  - 对应 SPEC §4.2 CLIEvent 类型定义
- [ ] **IMInteractionCallback 契约**：Daemon → IM 的交互动作（approval_request/confirm_replay/takeover_request 等）；IM → Daemon 的 IMCallbackAction（approve/deny/cancel/takeover_hard/takeover_soft/confirm_replay/discard）
  - 对应 SPEC §4.1.1
- [ ] **CLI↔IPC 命令真值表**：attach/attach_exit/open/open_thread/takeover 等命令在 CLI 和 IPC 两端的参数格式和生命周期行为完全一致
  - 对应 SPEC §3.7 IPC 命令表

### CLIPlugin

### CLIPlugin

- [x] 增加 `generateSessionId(): string` — 不同 CLI 的 session ID 格式可能不同
- [x] 增加 `validateSession(sessionId: string): Promise<boolean>` — attach/消息前验证 session 有效性
- [x] 将 `buildMessageCommand` 改为 `buildIMWorkerCommand`：长驻进程启动命令，不再以 per-message 方式启动进程
- [x] 定义 mm-coder 内部统一事件模型（基于 stream-json：`system | assistant | user | result | attachment | last-prompt | queue-operation`）
- [x] 增加 `parseStream(stream: NodeJS.ReadableStream): AsyncIterable<CLIEvent>` 流式输出解析

### IMPlugin

- [x] `sendMessage` content 改为结构化类型，支持 text/markdown/file
- [x] 增加 `updateMessage(target, messageId, content)` — 流式输出场景下更新同一条消息
- [x] `requestApproval` 返回类型扩展为 `ApprovalResult`
- [x] 评估审批 scope 是否支持”本次 / 本 session” — 已在 §3.4/§3.10 定版：支持 once | session 两级

### 类型定义

- [x] 定义 `IncomingMessage`、`MessageTarget`、`ApprovalRequest`、`ApprovalResult`、`CLIEvent` 等核心类型 — 已在 §3.10 定版

## P3: 设计补充

### 异常处理

- [x] `claude -p` 进程崩溃/超时的处理策略 — 已在 §3.8 定版：退避重启 1s/3s/10s，超阈值 → error
- [x] API 限流错误的处理策略 — 已在 §3.8 定版：遵循 CLI 原生重试/失败语义，daemon 不在 stdout 层做 429 文本解析与二次重试；若 worker 因 429 异常退出，按 worker_crash 路径处理
- [x] daemon 崩溃后的恢复算法：session、pending message、pending approval 的保守重建 — 已在 §3.8 定版

### 运行模式

- [x] 补充 `mm-coder tui`：通过 IPC 连接 daemon，提供多 session 总览和审批状态监控
- [x] 明确 TUI 与 attach 的边界：TUI 仅做控制台，不承载 AI CLI 交互
- [ ] TUI / status / IM 文案统一采用新的 runtimeState 语义（cold / ready / running / waiting_approval / attached_terminal / takeover_pending / recovering / error）

### IPC

- [x] 明确 IPC 方案：统一 Unix domain socket，定义 socket 文件路径（如 `~/.config/mm-coder/daemon.sock`）
- [x] 为 Unix socket 增加最小权限与对端身份校验

### Hook / Prompt Tool 注入

- [x] 明确 Claude Code 审批策略选定后的注入方式与隔离方案：daemon MCP server，IM worker 通过 `--permission-prompt-tool mm-coder-permission` 连接，autoAllow/autoDeny 在 server 层实现

### 排队消息

- [x] 定义终端 detach 后排队消息的自动处理行为 — 旧单轮语义已被常驻 worker 设计替代；当前定版见 §3.9：attached/takeover_pending 时普通 IM 文本默认拒绝，不再沿用“attached 期间默认入队”
- [x] 定义 pending message 的恢复语义：daemon 重启后是重放、丢弃还是标记待确认 — 已在 §3.8/§3.9 定版：默认 replay，高风险降级 confirm

### 权限配置归属

- [x] permissions 配置改为挂在 CLI 插件下（不同 CLI 的工具名不同）

### 命令一致性

- [x] 对齐 IM 命令和 CLI 命令的参数格式 — 已在 §3.7 增加 CLI⇄IPC 命令参数对齐表
- [x] 增加 `mm-coder import <session-id> [--name] [--workdir]` 命令，支持导入外部启动的 Claude Code session — 已在 §3.5/§3.7 定版

### MCP 授权闭环

- [x] **daemon 接入 ApprovalHandler 主链**：启动 daemon 时实际拉起 ApprovalHandler / socket 监听，并在 stop 时关闭，不能只停留在独立测试骨架
  - 对应 `src/daemon.ts`、`src/approval-handler.ts`
- [x] **MCP can_use_tool 上下文透传**：把 `messageId / correlationId / toolUseId / capability / operatorId` 等上下文从 worker 请求一路传到 ApprovalManager，不能只传 toolName/toolInput
  - 对应 `src/approval-handler.ts`、`src/approval-manager.ts`、`src/types.ts`
- [x] **IM 审批回调闭环**：IM 中的 approve/deny/cancel 动作必须能回写 ApprovalManager 决策，形成 requestApproval → 用户决策 → MCP allow/deny 的完整链路
  - 对应 `src/daemon.ts`、`src/approval-handler.ts`、IM callback 解析主链
- [x] **capability / riskLevel 真值落地**：requestApproval 不得继续硬编码 `shell_dangerous` / `medium`，需按真实工具能力与风险分类生成
  - 对应 `src/approval-handler.ts`
- [x] **审批 ACL 与 stale request 丢弃**：approver 权限检查、requestId 不匹配 stale 丢弃、first-write-wins 结果都要在真实运行链路中验证，而不只在单元测试里成立
  - 对应 `src/approval-manager.ts`、daemon IM 回调入口

### IM worker 单轮推进问题

- [x] **优先排查工具执行链/MCP 授权未接通**：当前 MM 下“只前进一步就停”的现象更可能源于 IM worker 工具执行链未真正打通，而不是 continuation prompt 语义不足
  - 对应 `src/im-worker-manager.ts`、`src/daemon.ts`、`src/approval-handler.ts`、`src/mcp-bridge.ts`
- [x] **必要时再修 turn 边界误判**：若 MCP 链路收口后问题仍存在，再继续检查历史回放/旧 result 提前收口当前轮的问题
  - 对应 `src/im-message-dispatcher.ts`、`src/stream-to-im.ts`、`src/plugins/cli/claude-code.ts`

### Mattermost 会话空间策略（thread / channel）

- [x] **spaceStrategy 配置落地**：Mattermost 配置新增 `spaceStrategy=thread|channel`，默认 `thread`；修改配置后仅影响未来新建 session，既有 session 不迁移
  - 对应 SPEC §2.4 / §2.7
- [ ] **单次 override 能力**：CLI / TUI 的单次创建或 open 动作可 override 全局默认 `spaceStrategy`，但 override 不回写配置文件
  - 对应 phase3 规划与后续实现切片
- [x] **`/status` / CLI status / TUI 展示当前模式**：全局与会话视图中展示当前 Mattermost 默认新建模式（thread / channel）以及当前 session 的实际绑定空间类型
  - 对应用户确认的产品要求
- [x] **新 session 创建入口统一受策略控制**：包括 CLI 创建、TUI 创建、IM `/open` 与 IM 普通文本自动建 session；都必须使用当前 `spaceStrategy`
  - 对应 SPEC §2.4 / §7
- [x] **channel 模式仅对 Mattermost 生效**：为未来 Discord 等插件保留扩展点，但当前不承诺跨 IM 通用 channel/thread 语义
  - 对应用户确认的范围约束
- [x] **channel 模式清理优先 archive/解绑，而非默认硬删除**：未来 remove/archive 语义需显式区分 thread 与 channel 两类空间，对 channel 默认采取 archive/解绑优先策略
  - 对应用户确认的产品约束

### Busy/Idle 与执行语义

- [ ] **busy/idle 三层模型落地**：实现 `status` / `runtimeState` / 执行补充字段（如 `activeMessageId`、`lastTurnOutcome`、`interruptReason`）的分层真值
  - 对应 SPEC §2.6、§3.2、§9，以及 `docs/STATE-INVARIANTS.md`
- [ ] **busy/idle 对外派生一致性**：CLI / IM / TUI 对 busy/idle 的二值派生统一为 `busy = running|waiting_approval|attached_terminal|takeover_pending|recovering`、`idle = cold|ready`
  - 对应 `docs/STATE-INVARIANTS.md` 与 `docs/IMPL-SLICES.resident-worker-tdd.md` R10
- [ ] **typing 状态真值继续细化**：当前已修复“长时间无新流事件仍持续发送 typing”的误报；后续可继续补 `lastTurnOutcome` / `interruptReason` / `lastResultAt` 等补充字段，让“等待下一步指令”与“仍在处理但静默”彻底分离
  - 对应 `docs/STATE-INVARIANTS.md`、`docs/EVENT-SEMANTICS.md` 与 `docs/IMPL-SLICES.resident-worker-tdd.md` R11
- [x] **typing indicator 绑定 busy 状态**：当 Mattermost 会话处于 `running` 时按节流发送 typing；`waiting_approval`、`ready`、`cold`、`recovering` 不发送；状态切换时立即停止续发
  - 对应 SPEC §2.5、§4.1、§4.1.1（新增设计）与 `docs/EVENT-SEMANTICS.md`
- [x] **typing REST 路径与官方真值对齐**：实现已从历史路径 `/api/v4/users/me/typing` 修正为官方 API reference 已确认的 `POST /api/v4/users/{user_id}/typing`；`user_id` 使用 connect 阶段解析出的 bot user id
  - 对应 `docs/RESEARCH.mattermost-typing-semantics.md`、`docs/MATTERMOST-GAPS.md` 与 SPEC typing 章节

### Mattermost WebSocket 健壮性

- [x] **WebSocket 逻辑活性检测**：不能只依赖底层 TCP 重连或浏览器/WebSocket 对象存活；需要应用层 heartbeat/ack/lastMessageAt 监测，识别“TCP 已恢复但 WS 逻辑失活”的半断链场景
  - 对应 SPEC §2.7（新增设计）
- [x] **WebSocket 主动自愈**：当超过心跳窗口未收到 Mattermost 事件或 heartbeat ack 时，主动 close 当前 WS 并重建，而不是无限信任现有连接
  - 对应 SPEC §2.7（新增设计）
- [x] **REST/WS 双通道健康模型**：Mattermost 插件应分别维护 REST 可用性与 WS 订阅活性，禁止只因 REST 正常就判定“IM 连接正常”
  - 对应 SPEC §2.7（新增设计）

- [x] 定义 session 清理策略：TTL / 手动归档 / 最大数量限制 — 已在 §9 定版：TTL 标记 stale 非删除，手动归档/删除，运行中 session 不受 TTL 影响
