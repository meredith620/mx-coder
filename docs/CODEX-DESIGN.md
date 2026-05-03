# mx-coder Codex 适配设计

> 本文档描述 mx-coder 对 `codex` CLI 的适配方案。  
> 目标是让 Codex 像 Claude Code 一样同时支持终端 attach 和 IM 远程交互，但底层协议、会话绑定方式、审批入口都必须按 Codex 自身能力实现，不能照搬 Claude Code 的参数和行为。

> 本文档是目标状态说明，不记录实现草稿；当前实施顺序和禁止事项以 [CODEX-TDD-PLAN.md](CODEX-TDD-PLAN.md) 为准。

---

## 1. 目标

1. 让 `mx-coder` 支持 `codex-cli` 作为新的 CLI plugin。
2. 支持终端 `attach` 和 IM worker 两条路径。
3. 支持 IM 里实时审批，但审批最终裁决仍由 `mx-coder` 控制。
4. 支持 Codex thread id 的两种来源：
   - 创建 session 后首次 attach / 首次 turn 回填
   - 导入已有 Codex thread id 后直接绑定

---

## 2. 设计原则

### 2.1 session 与 thread id 分层

- `mx-coder session` 是上层业务对象，负责名称、工作目录、IM 绑定、状态机和恢复调度。
- `codex thread id` 是 Codex 自身的运行时会话标识。
- session 不要求在创建时立即拥有 Codex thread id。
- 如果 session 已经导入了 Codex thread id，则 attach/resume 可以直接复用。
- 如果 session 还没有 Codex thread id，则在首次 attach / 首次 turn 后回填。

### 2.2 审批由 mx-coder 统一裁决

- 用户在 IM 里对审批消息做动作。
- `mx-coder` 收集动作、执行审批策略、记录审计。
- Codex 侧只接收最终 allow / deny 结果。
- 不使用 Claude Code 专有的 `--permission-prompt-tool` 思路作为 Codex 的主路径。

### 2.3 事件流以 Codex JSONL 为真值

Codex 的 stdout / SDK 事件流不是 Claude Code 的 stream-json。
需要按 Codex 自己的事件模型处理：

- `thread/started`
- `turn/started`
- `item/started`
- `item/updated`
- `item/completed`
- `turn/completed`
- `turn/failed`

其中：

- `thread/started` 提供 thread id 回填信号。
- `item/completed` 提供 assistant / reasoning / tool call 的完成事件。
- `turn/completed` / `turn/failed` 是一轮结束边界。

---

## 3. Codex 接入模式

### 3.1 终端 attach

attach 的目标是恢复或启动 Codex 终端交互。

规则：

- 如果 session 已绑定 Codex thread id，则 attach 时使用 `codex resume <thread_id>`。
- 如果 session 还没有 thread id，则 attach 时启动 Codex 的交互式 CLI，新线程会在运行时生成 thread id，再由 mx-coder 回填。
- `codex` 不带子命令时进入交互式 TUI。
- `codex resume` 仍是交互式 TUI 的恢复入口，支持 `--last`、`--all`、`--include-non-interactive`。
- attach 不应依赖 Claude Code 的 `--session-id` 语义。

### 3.2 IM worker

IM worker 负责把一条 IM 消息变成一个 Codex turn，并且必须是**常驻进程**。

规则：

- worker 接收 mx-coder 标准 worker input JSONL。
- worker 提取用户输入文本，作为 Codex turn prompt。
- worker 进程本身不应在每条 IM 消息后退出。
- resident backend 由 IM dispatcher 在首个待处理消息到来时懒加载，不能随着 `attach` 一起启动，更不能每条消息都重启。
- 首选 resident 入口是 `codex app-server --listen unix://<socket-path>`，因为它提供线程和 turn 级 RPC。
- `codex app-server` 的真实参数包括 `--listen stdio://|unix://|ws://|off`、`--analytics-default-enabled`、`--ws-auth`、`--ws-token-file`、`--ws-token-sha256`、`--ws-shared-secret-file`、`--ws-issuer`、`--ws-audience`、`--ws-max-clock-skew-seconds`，并有 `proxy` / `generate-ts` / `generate-json-schema` 子命令。
- mx-coder 通过 app-server 协议对 resident Codex 进程发送 `thread/start`、`thread/resume`、`turn/start`、`turn/interrupt` 等 RPC。
- `codex exec` 只作为一次性 fallback 或诊断工具，不作为 IM worker 的主路径。
- worker 将 Codex 事件归一化为 mx-coder 内部 CLIEvent。
- worker 将事件持续推送给 IM 渲染层。

### 3.3 事件归一化

Codex 事件需要映射为 mx-coder 内部事件语义。

建议映射：

- `thread/started` -> `system`
- `item/started` / `item/updated` / `item/completed` 中的 `agent_message` -> `assistant`
- `reasoning` -> `assistant` 的 thinking block
- `turn/completed` -> `result`
- `turn/failed` -> `result`，并标记 `is_error`
- 其他 item 类型保留为可展示摘要，但不能破坏轮次边界

事件映射的重点不是一比一复刻 Codex 结构，而是保证：

- 流式输出可视化正常
- turn 边界稳定
- cursor 回放不乱

### 3.4 Resident 生命周期

IM 侧 Codex 适配必须满足以下生命周期要求：

- 一个 session 对应一个 resident Codex 控制面进程。
- `attach` 只负责前台 TUI 控制权切换，不负责 resident backend 的生命周期。
- 当 TUI 退出后，mx-coder 继续接管这个 resident 进程，IM 仍通过同一个 `codex app-server` 与该 thread 交互。
- IM 消息到来时不应重新 spawn 一个新的 Codex 进程。
- 一旦 app-server 连接断开或 Codex 进程退出，mx-coder 需要把该 session 标记为 worker 失活并由 daemon 负责重建，而不是把每条消息都退化成一次性 `codex exec`。
- 如果 session 仍未绑定 thread id，则首次 `thread/started` 或 `thread/resume` 响应用于回填 mx-coder session id。
- 如果 session 已绑定 thread id，则后续消息直接在同一个 thread 上调用 `turn/start`。

---

## 4. 审批设计

### 4.1 目标语义

审批链路在 mx-coder 中保持统一：

- 用户在 IM 端批准 / 拒绝。
- daemon 作为审批控制面。
- worker 在 Codex 侧只等待最终结果。

### 4.2 交互入口

IM 侧审批应支持：

- reaction 快捷动作
- `/approve once`
- `/approve session`
- `/deny`
- `/cancel`

审批消息需要携带最小必要上下文：

- session name
- request id
- tool name
- tool input summary
- risk level
- scope options

### 4.3 与 Codex 的对接边界

Codex 自身是否弹出审批 UI，不作为 mx-coder 的依赖。
mx-coder 负责：

- 识别何时需要审批
- 将审批请求送到 IM
- 等待 IM 决策
- 将决策回传给 resident Codex 控制面

当前 `codex` CLI 的真实参数里，审批相关入口是 `--ask-for-approval <never|on-failure|on-request|untrusted>`。  
它没有暴露 Claude Code 那种 `--permission-prompt-tool` 级别的 CLI 参数。  
因此，`mx-coder` 要做 IM 实时审批，不能依赖一个不存在的 Codex CLI flag；需要把审批交互放在 mx-coder 的 bridge / worker 层上，再把 allow / deny 结果喂回 resident Codex 控制面。

---

## 5. session id / thread id 生命周期

### 5.1 创建 session

- `mx-coder create` 只分配 session 元数据。
- Codex thread id 可为空。
- session 仍然可以进入 `idle`、`attach_pending`、`im_processing` 等状态。

### 5.2 首次 attach / 首次 turn

- 如果 session 没有 thread id，Codex 首次启动后生成。
- 监听 `thread/started`。
- 触发 `updateSessionId` 或等价回填逻辑。
- 回填后 session 与 Codex thread id 绑定。

### 5.3 导入已有 Codex thread id

- import 时允许直接写入外部 thread id。
- attach / resume 优先使用该 id。
- 这条路径和首次回填路径必须共存。

---

## 6. 目录与模块边界

建议实现位置：

- `src/plugins/cli/codex-cli.ts`
  - Codex CLI plugin
  - session / thread id 绑定
  - attach 命令构造
  - worker 命令构造
  - session 诊断

- `src/plugins/cli/codex-worker-adapter.ts`
  - worker 输入解析
  - Codex 事件归一化
  - turn 生命周期驱动

- `src/plugins/cli/registry.ts`
  - 注册 `codex-cli`

- `src/plugins/types.ts`
  - CLIPlugin 扩展点

- `src/index.ts`
  - attach 后回填 session id 的调度

- `src/im-message-dispatcher.ts`
  - 处理 Codex 事件流 cursor 和 session 回填

---

## 7. 当前实现状态与约束

已有实现方向中，以下点是正确的：

- Codex 作为独立 CLI plugin。
- attach 后允许 session id 回填。
- 通过事件流把 Codex 输出翻译成 mx-coder 内部事件。
- registry 支持多 CLI plugin。

需要继续修正的点：

- 不能把 Claude Code 的 `--permission-prompt-tool` 思路直接搬到 Codex。
- Codex 事件模型不能只按 `stream-json` 的 Claude 事件处理。
- 需要把 Codex 的 thread id 获取和回填变成正式路径，而不是隐式副作用。

---

## 8. 验收标准

1. `mx-coder create --cli codex-cli` 可以创建 session。
2. `mx-coder attach` 能对 Codex session 启动 attach。
3. 首次 attach / 首次 turn 后能回填 Codex thread id。
4. 已导入 Codex thread id 的 session 可以直接 resume。
5. IM worker 能把 Codex 输出稳定转成 mx-coder 事件。
6. 审批动作能在 IM 中完成，并回传给 Codex worker。
7. 不依赖 Claude Code 专有参数即可完成 Codex 适配。
