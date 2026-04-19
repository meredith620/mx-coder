# mm-coder (Multi-modal Coder) 事件语义护栏

> **文档生命周期**：这是常驻 IM worker 架构下的长期护栏文档，不是临时设计草稿。  
> 当 Claude stream-json 事件模型、IPC 事件名、attach/takeover/approval 的事件协议、或 dispatcher/worker 的消息边界判定发生变化时，必须同步更新本文件。  
> 若实现与本文件冲突，以“已确认的 SPEC + 通过测试验证后的实现”作为新的真值来源，再反向修订本文档，避免未来 agent 继续沿用旧语义。

---

## 1. 目标

本文件定义 mm-coder 在常驻 IM worker 模式下的**事件语义真值**，避免以下常见错误：
- 把“消息完成”错误绑定到进程退出
- daemon 与 CLI 各自使用不同的 attach waiter 事件名
- approval / takeover / attach 对同一事件的理解不一致
- 多轮 stdout 流被错误拼成一轮

---

## 2. 事件来源分层

mm-coder 里有三类事件，不能混为一谈：

1. **Claude stdout 事件**
   - 来源：`claude -p --input-format stream-json --output-format stream-json`
   - 例：`system` / `assistant` / `user` / `result` / `attachment` / `last-prompt` / `queue-operation`

2. **MCP / permission 事件**
   - 来源：Claude worker 调用 permission prompt tool，经 bridge 转发到 daemon
   - 例：`can_use_tool` 请求、审批通过/拒绝/超时

3. **IPC server-push 事件**
   - 来源：daemon → CLI/TUI 长连接
   - 例：`session_state_changed`、attach waiter 唤醒事件

原则：**Claude 事件负责描述一轮消息处理过程；IPC 事件负责描述 mm-coder 控制面状态变化；二者不可互相替代。**

---

## 3. Claude stdout 事件语义

### 3.1 `result` 是消息完成边界

1. 对常驻 worker 模式，**一条消息完成的唯一可靠边界是 `result` 事件**。
2. 以下都不能作为完成边界：
   - 子进程退出
   - assistant 文本停止增长
   - tool_use/tool_result 结束
3. 收到 `result` 后，当前轮次才允许：
   - 标记消息 `completed/failed`
   - 解除队列冻结
   - 决定是否切 attach
   - 重置 crashCount（若整轮成功）

### 3.2 其他 Claude 事件的语义

- `system`
  - 初始化、会话元信息、内部系统事件
  - 不代表一轮消息完成
- `assistant`
  - Claude 正在输出内容
  - 代表当前轮次仍在进行中
- `user`
  - 可能包含 tool_result 等历史/中间输入
  - 不能直接当作新一轮开始的唯一判断
- `attachment` / `last-prompt` / `queue-operation` / 未来未知事件
  - 必须兼容解析
  - 不得导致当前轮次边界错乱

### 3.3 多轮流的切片原则

- 必须基于当前轮次上下文切片，至少要利用 `messageId` 或等价 turn 关联信息
- 同一 worker 的 stdout 是跨多轮连续流，不能默认“读到 EOF 就是一轮结束”
- 若出现未知事件类型，默认保留并忽略其对轮次完成性的影响，除非明确证据表明它是新的完成边界

---

## 4. approval 事件语义

### 4.1 approval_pending 的本质

- `approval_pending` 不是独立于消息存在的系统状态
- 它是“**当前活动消息**在常驻 worker 内执行到工具权限点时的阻塞子状态”

因此：
1. `approval_pending` 必须绑定当前活动消息
2. 它必须绑定一个待决 `requestId`
3. 它结束后只能回到：
   - `im_processing/running`（批准或拒绝后继续本轮）
   - `idle/cold/recovering`（超时/重启/取消导致本轮终止）

### 4.2 approval 决策事件

- `approved`
  - 当前轮继续执行
- `denied`
  - 当前轮继续收尾，但工具调用被拒绝
- `expired`
  - fail-closed，不能假装继续正常跑
- `cancelled`
  - 多用于 takeover / 新请求覆盖旧请求

---

## 5. attach / takeover 事件语义

### 5.1 attach 的控制权语义

attach 不是普通状态切换，而是**控制端切换**：

- 若 IM worker `ready`
  - 先停 worker
  - 再 attach
- 若 IM worker `running`
  - 进入 `attach_pending`
  - 等当前轮 `result`
  - 再停 worker、attach
- 若 IM worker `waiting_approval`
  - 必须先完成或取消审批
  - 再停 worker、attach

### 5.2 takeover 的控制权语义

- soft/hard takeover 都是“从终端收回控制权”
- `takeover-force` 可以终止终端 Claude 进程
- 终端被释放后，daemon 不能假设旧 IM worker 仍可用；需要显式进入 `cold`、`ready` 或 pre-warm 路径

---

## 6. IPC 事件语义

### 6.1 attach waiter 唤醒事件必须唯一

当前实现存在 `attach_ready` / `session_resume` 双命名风险。未来必须收敛为**唯一真值事件名**。

要求：
1. daemon 只发送一种 attach waiter 唤醒事件
2. `attach.ts` 只监听这一种事件
3. 测试必须覆盖“事件名统一”

在未统一前，任何 agent 改动 attach 流程时，都必须先 grep：
- `attach_ready`
- `session_resume`

确认不存在双真值后再改。

### 6.2 `session_state_changed`

- 作用：通知 TUI/观察者会话状态已变化
- 不代表 attach waiter 可继续
- 不得被 attach CLI 误当作唤醒信号

### 6.3 Mattermost WebSocket 活性事件

- Mattermost WS `open` 仅表示传输层建立，不代表订阅逻辑健康
- `authentication_challenge` 发送成功也不代表后续一定能持续收到 `posted` 事件
- 必须维护应用层活性时间戳，例如：
  - `lastWsMessageAt`
  - `lastHeartbeatAckAt`
- 若超出活性窗口未收到 WS 消息或 heartbeat ack，应主动触发“逻辑断链恢复事件”：
  - close 当前 WS
  - 清理旧连接状态
  - 重新走 WS 建连与认证
- 该恢复动作属于插件层事件，不等同于 daemon IPC 的 `session_state_changed`

---

## 7. 恢复事件语义

1. daemon 重启后，不恢复旧 worker 进程控制面
2. 若持久化前处于 `ready`
   - 重启后也必须视为 `cold` 或恢复路径，直到新 daemon 显式重建 worker
3. `approval_pending` 重启后必须 fail-closed
4. `running` 中断后恢复动作由 `restoreAction` 决定：
   - `replay`
   - `confirm`
   - `discard`
5. 恢复动作是调度层事件，不是 Claude 原生事件

---

## 8. typing indicator 语义

1. typing indicator 不是 Claude Code 原生状态，而是 mm-coder 基于 `runtimeState=running` 派生出的 IM 侧提示行为。
2. typing 只在“当前轮正在执行且最近仍有新的 Claude 流事件”时发送。
3. 以下状态不得发送 typing：
   - `ready`
   - `cold`
   - `waiting_approval`
   - `recovering`
   - `attached_terminal`
   - `takeover_pending`
4. typing 必须节流，避免高频调用 Mattermost API。
5. 当状态从 `running` 切出后，应立即停止后续 typing 续发。
6. 即使 session 仍暂时保持 `running`，若超过静默窗口未再收到新的 Claude 流事件，也必须停止 typing 续发，避免“Claude 已在等待下一步指令，但 Mattermost 仍显示 typing”的误报。

## 9. 典型误用（看到就该拦下）

- 用“worker 退出”判断一轮消息完成
- 把 `approval_pending` 当成与当前消息无关的全局状态
- attach waiter 监听 `session_state_changed` 而不是专用唤醒事件
- takeover-force 后直接复用旧 IM worker stdin/stdout
- daemon 重启后把持久化的 `ready` 当成真实 ready

---

## 10. 推荐测试覆盖

至少应覆盖：
1. `result` 作为完成边界的测试
2. 多轮连续 stdout 不串轮的测试
3. approval_pending 绑定当前活动消息的测试
4. attach_ready / session_resume 事件名统一性测试
5. takeover-force 后 worker 重建路径测试
6. daemon 重启后 ready → cold 的测试
7. Mattermost WS 半断链场景下 heartbeat 超时后主动重连测试
8. typing indicator 仅在 `runtimeState=running` 时发送、且遵循节流的测试

---

## 11. 维护规则

当以下任一内容发生变化时，必须同步更新本文件：
- `src/plugins/cli/claude-code.ts` 的 `parseStream`
- `src/im-message-dispatcher.ts` 的队列出队和完成判定逻辑
- `src/approval-handler.ts` / `src/approval-manager.ts`
- `src/attach.ts` 与 daemon IPC waiter 协议
- `docs/SPEC.md` 中数据流、审批、恢复、IPC 章节

若未来引入新的 Claude 事件类型或新的 IPC 事件：
1. 先增加测试
2. 明确它是否改变消息边界 / 审批边界 / attach 唤醒语义
3. 再更新本文档
