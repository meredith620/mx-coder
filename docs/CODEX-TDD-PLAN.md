# mx-coder Codex 适配 TDD Plan

> 本文件给 agent 作为实现顺序参考。  
> 原则：先测试，再实现；先小范围接口，再事件流，再审批，再 attach/resume 细节。

---

## 0. 执行前提

在开始实现前先确认：

1. Codex CLI 的真实启动参数和 JSONL 事件模型。
2. thread id 的来源是否稳定来自 `thread.started`。
3. 审批链路不能依赖不存在的 CLI flag；如果要做 IM 实时审批，只能通过 mx-coder 的 worker / bridge 承担。

若某项和设计不一致，先更新设计文档，再写实现。

---

## 1. 第一阶段: CLI plugin 基础契约

### 目标

把 Codex 插件作为可注册的 CLI plugin 接入，但不碰复杂事件流。

### 测试优先清单

1. `tests/unit/cli-plugin-registry.test.ts`
   - `getCLIPlugin('codex-cli')` 返回 Codex 插件实例
   - `listCLIPlugins()` 包含 `codex-cli`

2. `tests/unit/codex-cli-plugin.test.ts`
   - `buildAttachCommand` 在没有 thread id 时返回新启动命令
   - `buildAttachCommand` 在已有 thread id 时返回 resume 命令
   - `getSessionDiagnostics` 返回 Codex home / session path / nextAttachMode
   - `generateSessionId()` 生成 UUID

### 实现内容

- 增加 `CodexCLIPlugin`
- 增加 Codex home / sessions 扫描逻辑
- 增加 session 诊断输出
- attach/resume 真实命令应以 `codex resume` / `codex` 交互入口为准，而不是 Claude Code 的 `--session-id`

### 通过标准

- 不依赖 Claude Code 的 session 文件即可判断 Codex 会话状态。

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

### 实现内容

- `handleAttach()` 保持 session 主键不变，attach 后触发 Codex id 回填
- `SessionRegistry.updateSessionId()` 对 Codex 绑定场景保持幂等

### 通过标准

- 新建 session、首次 attach、import 既有 thread id 三条路径都可用。

---

## 3. 第三阶段: Codex 事件流归一化

### 目标

把 Codex JSONL 输出变成 mx-coder 内部可消费的 CLIEvent。

### 测试优先清单

1. `tests/unit/codex-worker-adapter.test.ts`
   - `extractPromptFromWorkerInput()` 读取 worker 输入文本
   - `normalizeCodexExecEvent()` 处理 `thread.started`
   - `normalizeCodexExecEvent()` 处理 `item.completed` 的 agent_message
   - `normalizeCodexExecEvent()` 处理 `turn.completed`
   - `normalizeCodexExecEvent()` 处理 `turn.failed`

2. `tests/unit/parse-stream.test.ts`
   - 增加对 Codex 风格事件的兼容测试
   - 确保未知事件不破坏 turn 边界

3. `tests/e2e/im-message-flow.test.ts`
   - IM 消息进入 Codex worker 后，assistant/result 能正常回传

### 实现内容

- worker adapter 负责从 stdin 读 mx-coder worker 输入
- adapter 负责启动 `codex exec --json`
- adapter 负责 stdout JSONL 到 CLIEvent 的映射

### 通过标准

- 一条 IM 消息能够完整跑通 Codex turn。
- assistant 流和 result 边界稳定。

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
- Codex worker 只消费 allow / deny 结果
- 审批消息带上最小上下文：toolName、toolInputSummary、riskLevel、scopeOptions
- worker 实现不应依赖不存在的 `--permission-prompt-tool`；若需要 Codex 侧支持审批等待，先验证是否能通过 `--ask-for-approval` 与 bridge 组合实现，再决定最终方案

### 通过标准

- 不需要在 Codex TUI 里做审批，也能在 IM 中完成全部决策。

---

## 5. 第五阶段: attach / IM 切换与恢复

### 目标

让 Codex session 在 attach 与 IM worker 之间稳定切换。

### 测试优先清单

1. `tests/integration/attach-flow.test.ts`
   - attach 时不重复创建 session
   - attach 后能正确释放 IM worker

2. `tests/integration/im-routing.test.ts`
   - IM 消息在 Codex session 上正确路由

3. `tests/e2e/reattach-after-exit.test.ts`
   - 退出 attach 后可再次 attach，并继续使用同一 Codex thread

### 实现内容

- 保持 `attach` 是控制权切换，不是 session 重建
- 处理 `thread.started` 回填对恢复逻辑的影响

### 通过标准

- 终端和 IM 不会同时驱动同一 Codex thread。

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
