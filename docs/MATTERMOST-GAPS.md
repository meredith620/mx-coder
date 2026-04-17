# mm-coder (Multi-modal Coder) Mattermost 设计差距清单

> **文档生命周期**：这是“实现前收口用”的阶段性 gap 文档。它的价值在于帮助 AI agent 和 reviewer 快速判断“当前代码离目标设计还差什么”。  
> 当相应缺口被实现并由测试覆盖后，应及时缩减、更新，最终可以将已关闭项删除，或在该文档仅保留未完成差距。若未来 Mattermost 架构再次大改，可重建新版本，不要求长期像 SPEC 一样稳定，但要求在“当前迭代窗口内”保持准确。

---

## 1. 目标

本文件对比：
- **当前实现**：`src/plugins/im/mattermost.ts`
- **目标设计**：`docs/SPEC.md`、`docs/STATE-INVARIANTS.md`、`docs/EVENT-SEMANTICS.md`、`docs/IMPL-SLICES.resident-worker-tdd.md`

输出一份“还能直接开工的 gap list”，避免 agent 反复自己读代码后再归纳。

---

## 2. 当前实现概况

当前 Mattermost 插件已经具备：
- 配置加载与校验
- `connect()` 中通过 `/api/v4/users/me` 校验 token
- WebSocket 连接与 `authentication_challenge`
- 处理 `posted` 事件并转成 `IncomingMessage`
- `sendMessage` / `createLiveMessage` / `updateMessage` / `requestApproval`
- 基础重连：`close` 后按 `reconnectIntervalMs` 重试

这说明它已经有“能用的基础骨架”，但距离目标设计还有几处关键缺口。

---

## 3. Gap 清单

### G1. WebSocket 健康判定过于乐观
**现状**：
- 只在 `open`/`close` 维度管理 WS
- `close` 后会重连
- 但没有应用层活性检测

**风险**：
- 会出现“TCP/WS 对象还活着，但订阅逻辑已断”的半断链
- 在这种情况下，`onMessage()` 不再收到 `posted`，但系统也不会主动恢复

**目标**：
- 增加 `lastWsOpenAt` / `lastWsMessageAt` / `lastHeartbeatSentAt` / `lastHeartbeatAckAt`
- 维护 heartbeat 或等价活性检测
- 超过活性窗口后主动 `close()` 并重连

**优先级**：P1

---

### G2. 缺少 REST/WS 双通道健康模型
**现状**：
- `sendMessage()` 走 REST
- `onMessage()` 走 WS
- 但没有独立健康状态表达

**风险**：
- REST 正常时，系统容易误以为 IM 整体健康
- 实际上 WS 可能已失活，消息订阅断掉

**目标**：
- 分开维护：
  - `restHealthy`
  - `wsHealthy`
  - `subscriptionHealthy`
- 对外诊断时区分“能发不能收”“能收不能发”“双向都好”

**优先级**：P1

---

### G3. 缺少 typing indicator 能力
**现状**：
- `IMPlugin` 目标设计已有 `sendTyping?()`
- Mattermost 插件当前未实现 typing 能力

**风险**：
- busy/idle 设计无法完整投射到 IM 用户体验
- 用户在长任务执行时缺少“Claude 仍在忙”的低成本反馈

**目标**：
- 在 Mattermost 插件中实现 `sendTyping?()`
- 由 daemon/dispatcher 按 `runtimeState=running` + 节流策略调用

**优先级**：P2（但建议与 busy/idle 对外呈现一起做）

---

### G4. 缺少 typing 节流与停止语义
**现状**：
- 当前无 typing
- 也无续发/停止机制

**风险**：
- 若未来直接在每个 token 上发 typing，会造成 API 噪音与限流风险
- 若开始发但不停止，会误导用户

**目标**：
- 建议每 3~5 秒最多发一次 typing
- 仅 `runtimeState=running` 发送
- 状态切出 `running` 时立即停止续发

**优先级**：P2

---

### G5. 缺少 WS 活性相关测试
**现状**：
- 现有测试主要覆盖基本 REST/WS 连接与消息收发
- 未覆盖半断链、自愈、旧连接清理、重复消息分发

**风险**：
- 实现保活后容易写出“表面能重连，但状态没清干净”的 bug

**目标**：
- 新增 `mattermost-ws-resilience` 测试组
- 覆盖：
  - heartbeat 超时后主动 close + reconnect
  - 旧连接状态清理
  - REST 正常但 WS 失活的诊断语义

**优先级**：P1

---

### G6. 缺少状态诊断输出
**现状**：
- 插件内部没有暴露“当前连接状态摘要”

**风险**：
- 长时间运行问题很难定位
- 出现“能发不能收”时缺少快速诊断面

**目标**：
- 增加内部诊断字段或方法，例如：
  - `getConnectionHealth()`
  - 返回 REST/WS/heartbeat 时间戳摘要
- 供 daemon diagnose/status 或 debug log 使用

**优先级**：P2

---

## 4. 不属于 Mattermost 插件单独解决的内容

以下问题不能只在 `mattermost.ts` 内解决，需要 daemon / registry / dispatcher 配合：

1. **busy/idle 真值**
   - 真值在 SessionRegistry / daemon，不在 Mattermost 插件
   - Mattermost 只消费 `runtimeState` 结果

2. **typing 发送时机**
   - 插件只提供 `sendTyping?()` 能力
   - 是否发送、何时发送、何时停止，应由 daemon/dispatcher 依据 runtimeState 决定

3. **attach waiter 事件名统一**
   - 这是 IPC / attach 协议问题，不是 Mattermost 插件问题

---

## 5. 推荐实现顺序

建议按以下顺序做：

1. **先做 G1 + G2 + G5**
   - 先把 WS 健壮性补上
   - 否则长期运行可靠性仍然不够

2. **再做 busy/idle 对外呈现 + G3 + G4**
   - 让 typing 与新 runtimeState 一起落地

3. **最后做 G6**
   - 作为可观测性补齐

---

## 6. 与 TDD slices 的映射

- G1 / G2 / G5 → `docs/IMPL-SLICES.resident-worker-tdd.md` 的 **R10**
- G3 / G4 → `docs/IMPL-SLICES.resident-worker-tdd.md` 的 **R11**
- G6 → 可并入 **R11** 或后续诊断切片

---

## 7. 维护规则

当以下任一内容发生变化时，应回看本文件是否仍准确：
- `src/plugins/im/mattermost.ts`
- `docs/SPEC.md` 的 Mattermost / typing / runtimeState 章节
- `docs/IMPL-SLICES.resident-worker-tdd.md` 的 R10 / R11
- `docs/TODO.md` 中 Mattermost 健壮性与 typing 待办

若某个 gap 已实现并有测试覆盖：
1. 在本文件中删除或标记已关闭
2. 不要把“已实现差距”长期留在这里制造噪音
