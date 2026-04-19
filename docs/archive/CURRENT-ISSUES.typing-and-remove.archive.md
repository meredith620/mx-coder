# mm-coder (Multi-modal Coder) 当前版本问题排查与修复归档

> **文档生命周期**：本文件原用于指导修复当前明确暴露的现实问题。相关修复已完成并通过针对性测试，现转为归档/核对材料。若后续行为回归，应以当前测试与实现为准重新开启新问题文档，而不是继续沿用本文件中的旧“待修复”表述。  
> **补充说明**：其中 typing 的“行为语义修复”已完成，但当前实现所用 REST 路径与本轮再核实拿到的官方 REST API reference 真值仍未完全对齐，因此 typing 不能再表述为“连路径都已被官方完全确认收口”。

---

## 1. 已完成范围

本轮已完成并验证以下问题：

1. **Mattermost typing indicator 不生效**
2. **`mm-coder remove <name>` 后托管 Claude worker 进程残留**
3. **Mattermost heartbeat ack 关联过宽的最小必要补强**

约束保持不变：
- 未偏离 resident worker 主设计
- 全程先补测试，再做最小实现
- 未引入第二套状态语义
- typing 仍是 `runtimeState=running` 的派生行为，不是 Claude 原生状态

---

## 2. 问题 A：typing indicator 不显示（行为与 REST 路径均已收口）

### 根因
- `src/plugins/im/mattermost.ts` 原先把 `sendTyping()` 错误实现为 `POST /api/v4/posts`
- 主路径原先也未把 typing keepalive 与 `runtimeState=running` 绑定

### 已落实语义
- `sendTyping()` 当前调用 **`POST /api/v4/users/{user_id}/typing`**
- `user_id` 直接使用 `connect()` 阶段解析出的 bot user id
- 请求体包含 `channel_id`，thread 场景携带 `parent_id`
- typing 由 dispatcher 主路径触发
- 仅 `runtimeState=running` 时按节流发送
- `waiting_approval` / `ready` / `cold` / `recovering` / `attached_terminal` / `takeover_pending` 不发送
- 离开 `running` 后立即停止续发

### 当前官方语义再核实结论
- 已能确认的官方 WebSocket 真值：
  - `user_typing` 是客户端 action
  - 服务端事件是 `typing`
  - `data` 支持 `channel_id` / `parent_id`
- 已能确认的官方 REST API reference 真值：
  - `POST /api/v4/users/{user_id}/typing`
  - body 字段为 `channel_id`（必填）与 `parent_id`（可选）
- 当前实现：
  - 已修正为使用官方真值 `/api/v4/users/{user_id}/typing`
  - 当前仍**没有官方文档证据**证明 `/users/me/typing` 为正式 endpoint 或官方 alias

因此本问题当前结论为：
- **typing 行为语义已修复并通过测试**
- **typing REST 路径也已修正到官方真值并通过测试**
- `/users/me/typing` 只能作为历史实现路径说明，不能再写成官方已确认正确

### 补充修复：typing 状态误判
后续又发现一个更细的状态语义问题：
- 当 Claude 已暂时停止产出、正在等待下一步输入，但当前轮尚未被粗粒度地判定结束时
- mm-coder 仍可能持续续发 Mattermost typing，造成人工观察上的“Claude 已停，但 Mattermost 仍显示 typing”

本轮已做的最小修复：
- typing 续发除了要求 `runtimeState=running`，还要求“最近仍有新的 Claude 流事件”
- 若超过静默窗口未再收到新事件，则停止后续 typing 续发
- `error` 事件不再被当作当前轮已完成的提交边界；只有 `result` 仍是完成边界

这次修复的作用是：
- 不再把“长时间静默等待下一步指令”误报成持续 typing
- 同时避免因为瞬时 `error` 事件而过早结束当前 turn

### 已覆盖测试
- `tests/unit/mattermost-plugin.test.ts`
  - `sendTyping` 使用官方 REST endpoint 与 bot user id
- `tests/integration/im-routing.test.ts`
  - `runtimeState=running` 时按节流发送 typing
  - 非 running 状态不发送 typing
  - 消息完成后停止续发
  - 长时间无新流事件时停止 typing 续发，避免误报持续输入
  - `error` 事件不会提前结束当前 turn


---

## 3. 问题 B：remove 后 Claude worker 残留（已修复）

### 根因
- `src/daemon.ts` 原先的 remove handler 只删 registry
- remove 前未调用 `this._imWorkerManager?.terminate(name)`

### 已落实语义
- remove idle + cold session：允许删除
- remove idle + ready session：若存在 IM worker，先 terminate worker，再 remove registry
- remove attached / attach_pending / takeover_pending session：默认拒绝 remove，并返回明确错误

### 已覆盖测试
- `tests/integration/daemon-commands.test.ts`
  - remove idle + cold session
  - remove idle + ready(with worker pid) session → worker terminate
  - remove attached session → 返回明确错误且 session 保留

---

## 4. 问题 C：keepalive 最小补强（已完成最小必要范围）

### 发现的问题
- heartbeat ack 原先采用“`seq_reply` 或 `status === 'OK'` 即刷新 ack 时间戳”的宽匹配
- 这会把非当前 heartbeat 的普通响应也错误计入活性确认

### 已落实语义
- 维护当前 heartbeat seq
- 仅当 `seq_reply === 当前 heartbeat seq` 时才刷新 `lastHeartbeatAckAt`
- 保留现有 heartbeat + timeout + force reconnect 主体，不做外层重连框架重写

### 已覆盖测试
- `tests/unit/mattermost-plugin.test.ts`
  - 只有匹配当前 heartbeat seq 的 ack 才刷新 ack 时间戳
  - heartbeat 超时后主动 close 并重连

---

## 5. 当前结论

本文件原聚焦的现实问题大体已收口：
- typing 的**行为语义**已按设计工作
- typing 的**REST 路径**已按官方 API reference 修正到 `/api/v4/users/{user_id}/typing`
- remove 已具备进程清理闭环
- heartbeat ack 已做最小必要补强

当前剩余要求主要是文档维护纪律：
- 不要再把旧实现路径 `/api/v4/users/me/typing` 写成官方真值
- 若未来要重新讨论该路径，只能在拿到官方 alias 证据后进行
- 若要从根上彻底消除“等待下一步指令”与“仍在处理但静默”的混淆，还需继续落地 `lastTurnOutcome` / `interruptReason` / `lastResultAt` 等补充字段

若后续需要继续增强 Mattermost 健壮性，应转到：
- `docs/MATTERMOST-GAPS.md`
- `docs/TODO.md`
- `docs/SPEC.md`
- `docs/RESEARCH.mattermost-typing-semantics.md`

---

## 6. 建议同步文档

本轮修复后，建议同步以下文档状态：
- `docs/MATTERMOST-GAPS.md`：仅保留当前仍未关闭的增强项，避免重复 gap
- `docs/TODO.md`：将 typing 路径待修正项标记为已完成，仅保留后续增强项
- `docs/SPEC.md`：typing REST 真值按官方 API reference 维持为 `/api/v4/users/{user_id}/typing`
