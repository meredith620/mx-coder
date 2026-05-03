# mx-coder Codex 适配 TDD Plan

> 本文件给 agent 作为实现顺序参考。  
> 原则：先测试，再实现；先小范围接口，再事件流，再审批，再 attach/resume 细节。

---

## 0. 执行前提

在开始实现前先确认：

1. Codex CLI 的真实启动参数和 app-server / exec / interactive TUI 的边界。
2. thread id 的来源是否稳定来自 `thread/started` 或 `thread/resume` 的响应。
3. 审批链路不能依赖不存在的 CLI flag；如果要做 IM 实时审批，只能通过 mx-coder 的 worker / bridge 承担。
4. IM worker 必须是 resident 进程，不允许每条消息都 spawn 一个新的 `codex exec`。

若某项和设计不一致，先更新设计文档，再写实现。

### 0.1 交接约束

当前仓库里与 Codex 相关的现有未提交改动，只能视为起点而不是完成品。后续 agent 必须遵守：

- `src/plugins/cli/codex-cli.ts` 只负责 Codex 插件骨架、attach 命令和 worker 入口选择，不得把 `codex exec` 当作 IM 主路径。
- `src/plugins/cli/codex-worker-adapter.ts` 必须按 resident app-server 方案重写，不能沿用 per-message exec。
- `src/index.ts` 与 `src/im-message-dispatcher.ts` 里的通用回填与懒加载逻辑可以保留，但 thread id / session id 的真实来源必须按 Codex app-server 协议校准。
- README 的 Codex 表述在实现收敛前不作为事实依据，交接时优先以本 TDD 计划为准。

### 0.2 当前结论

1. `attach` 走前台交互式 `codex` / `codex resume`。
2. IM worker 走常驻 `codex app-server --listen unix://...`。
3. resident backend 由 IM dispatcher 懒加载，不跟 attach 共享生命周期。
4. 任何 IM turn 都必须复用同一个 resident backend，而不是新起 `codex exec`。
5. 审批由 mx-coder 统一裁决，Codex 只消费 allow / deny 结果。

---

## 1. 第一阶段: CLI plugin 基础契约

### 目标

把 Codex 插件作为可注册的 CLI plugin 接入，并明确前台 attach 与 resident app-server 的分工，但不碰复杂事件流。

### 测试优先清单

1. `tests/unit/cli-plugin-registry.test.ts`
   - `getCLIPlugin('codex-cli')` 返回 Codex 插件实例
   - `listCLIPlugins()` 包含 `codex-cli`

2. `tests/unit/codex-cli-plugin.test.ts`
   - `buildAttachCommand` 在没有 thread id 时返回交互式启动命令
   - `buildAttachCommand` 在已有 thread id 时返回 resume 命令
   - `getSessionDiagnostics` 返回 Codex home / session path / nextAttachMode
   - `generateSessionId()` 生成 UUID

### 实现内容

- 增加 `CodexCLIPlugin`
- 增加 Codex home / sessions 扫描逻辑
- 增加 session 诊断输出
- attach/resume 真实命令应以 `codex resume` / `codex` 交互入口为准，而不是 Claude Code 的 `--session-id`
- resident worker 主路径应使用 `codex app-server --listen unix://...`
- resident backend 必须由 IM dispatcher 懒加载，不能跟 `attach` 共享启动时机

### 通过标准

- 不依赖 Claude Code 的 session 文件即可判断 Codex 会话状态。
- 新 agent 在未完成 resident worker 前，不应修改 attach 的前台交互语义。

---

## 2. 第二阶段: attach 回填与 import 绑定

### 目标

让 session 能在首次 attach / 首次 turn 后回填 Codex thread id，也能导入已有 thread id。

### 测试优先清单

1. `tests/unit/codex-cli-plugin.test.ts`
   - `findLatestSessionId` 能从 Codex rollout / session 文件中找到最新 thread id

2. `tests/integration/daemon-attach.test.ts`
   - Codex session attach 之后能回填 session id
   - 回填不会破坏现有 session 状态机

3. `tests/integration/daemon-import.test.ts`
   - 导入已有 Codex thread id 后，attach/resume 直接复用该 id
   - resident app-server 不会在每条消息后退出

### 实现内容

- `handleAttach()` 保持 session 主键不变，attach 后触发 Codex id 回填
- `SessionRegistry.updateSessionId()` 对 Codex 绑定场景保持幂等
- worker 进程生命周期从“单条消息”提升为“session 级 resident 连接”

### 通过标准

- 新建 session、首次 attach、import 既有 thread id 三条路径都可用。
- 同一 session 的多条 IM 消息复用同一个 Codex resident process。
- 任何回填逻辑都必须是幂等的，不得把 thread id 覆盖成 per-message 临时值。

---

## 3. 第三阶段: Codex 事件流归一化

### 目标

把 resident Codex 的事件流变成 mx-coder 内部可消费的 CLIEvent。

### 测试优先清单

1. `tests/unit/codex-worker-adapter.test.ts`
   - `extractPromptFromWorkerInput()` 读取 worker 输入文本
   - `normalizeCodexExecEvent()` 处理 `thread/started`
   - `normalizeCodexExecEvent()` 处理 `item/completed` 的 agent_message
   - `normalizeCodexExecEvent()` 处理 `turn/completed`
   - `normalizeCodexExecEvent()` 处理 `turn/failed`

2. `tests/unit/parse-stream.test.ts`
   - 增加对 Codex 风格事件的兼容测试
   - 确保未知事件不破坏 turn 边界

3. `tests/e2e/im-message-flow.test.ts`
   - IM 消息进入 Codex worker 后，assistant/result 能正常回传

### 实现内容

- worker adapter 负责从 stdin 读 mx-coder worker 输入
- adapter 负责启动或连接 `codex app-server --listen unix://...`
- adapter 负责对 resident app-server 发起 `thread/start` / `thread/resume` / `turn/start` / `turn/interrupt`
- adapter 负责事件流归一化与 cursor 管理
- 任何时候都不能把每条 IM 消息降级成一次新的 `codex exec`

### 通过标准

- 一条 IM 消息能够完整跑通 Codex turn。
- assistant 流和 result 边界稳定。
- 连续两条 IM 消息复用同一个 resident Codex 进程，不重新 spawn。
- 只要 resident app-server 还能连通，就不能在消息边界重新启动 Codex。

---

## 4. 第四阶段: 审批链路

### 目标

让用户在 IM 中对 Codex 工具调用进行批准 / 拒绝。

### 测试优先清单

1. `tests/unit/approval-handler.test.ts`
   - 审批请求进入 daemon 后能创建 pending approval
   - approve / deny / cancel 能正确回传结果
   - 超时走 fail-closed

2. `tests/integration/approval-flow.test.ts`
   - IM reaction / slash command 能驱动审批结果
   - `scope=once` / `scope=session` 生效

3. `tests/e2e/approval-e2e.test.ts`
   - 端到端验证 Codex worker 请求审批，IM 动作回传后继续执行

### 实现内容

- 审批仍由 `ApprovalManager` / `ApprovalHandler` 统一控制
- resident Codex 控制面只消费 allow / deny 结果
- 审批消息带上最小上下文：toolName、toolInputSummary、riskLevel、scopeOptions
- worker 实现不应依赖不存在的 `--permission-prompt-tool`；审批等待应由 resident bridge 保持连接并把决策回传给同一 Codex 控制面

### 通过标准

- 不需要在 Codex TUI 里做审批，也能在 IM 中完成全部决策。
- 不能把审批等待状态实现成 per-message exec 的阻塞等待。

---

## 5. 第五阶段: attach / IM 切换与恢复

### 目标

让 Codex session 在 attach 与 IM worker 之间稳定切换，同时保持 resident Codex 进程常驻。

### 测试优先清单

1. `tests/integration/attach-flow.test.ts`
   - attach 时不重复创建 session
   - attach 后能正确释放 IM worker

2. `tests/integration/im-routing.test.ts`
   - IM 消息在 Codex session 上正确路由
   - worker 断连后能由 daemon 触发重建，但不是每条消息重启

3. `tests/e2e/reattach-after-exit.test.ts`
   - 退出 attach 后可再次 attach，并继续使用同一 Codex thread

### 实现内容

- 保持 `attach` 是控制权切换，不是 session 重建
- 终端 attach 退出后，resident backend 仍保留给后续 IM 消息复用
  - 处理 `thread/started` / `thread/resume` 回填对恢复逻辑的影响
- resident Codex 进程在 TUI 退出后仍保持存活，直到 session 显式结束或 daemon 重建

### 通过标准

- 终端和 IM 不会同时驱动同一 Codex thread。
- IM 与 Codex 之间是长连接，不是 per-message exec。
- attach 退出后，resident backend 必须仍可被 IM 复用。

---

## 6. 第六阶段: 回归与文档收敛

### 目标

把 Codex 适配结果写回长期文档，减少后续 agent 误判。

### 必做项

1. 更新 README / docs 中 CLI 支持说明。
2. 补充事件语义文档里关于 Codex 的分支。
3. 如果 Codex 的真实协议和当前设计有偏差，先修设计文档，再修实现。

### 验收命令

- `npm run check`
- `npm run test:unit`
- `npm run test:integration`

---

## 7. 交接执行方式

下一个 agent 应按以下顺序继续：

1. 先重写 `src/plugins/cli/codex-worker-adapter.ts`，把 per-message exec 改成 resident app-server 客户端。
2. 再校准 `src/plugins/cli/codex-cli.ts`，确保 attach 语义仍然只是前台交互入口。
3. 然后补齐 resident worker 的单元测试和集成测试。
4. 最后再整理 README 或其他面向用户的说明。

禁止事项：

- 不要把 `codex exec` 重新引回 IM 主路径。
- 不要让 attach 生命周期控制 resident backend。
- 不要在没有 resident backend 的情况下通过“临时补丁”伪造 thread id 回填。
