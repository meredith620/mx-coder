# mx-coder (Multi-modal Coder) 当前状态 review 与后续计划

> **文档生命周期**：这是在 phase2-final 完成后，对当前实现与文档状态的复核记录。用于回答“现在是否可以进入 phase3、还剩哪些增强项、下一位 agent 该做什么”。  
> 当 phase3 开始实施并推进后，本文件应被阶段性更新或归档，不要长期让它与 SPEC / TODO 并行漂移。

---

## 1. 当前状态 review 结论

### 1.1 我对当前实现的判断
当前实现已经可以认为：
- resident worker phase2 主架构**已经收口**
- typing 的**行为语义 + 官方 REST 路径**已对齐
- remove 的进程清理闭环已完成
- Mattermost keepalive 最小必要补强已完成
- 进入 phase3 是合理的

### 1.2 我核对后的关键事实

#### typing
- 当前实现：`src/plugins/im/mattermost.ts` 已改为
  - `POST /api/v4/users/{user_id}/typing`
  - `user_id` 使用 `connect()` 阶段解析出的 bot user id
- 单测：`tests/unit/mattermost-plugin.test.ts` 已断言该路径
- dispatcher 主路径：`src/im-message-dispatcher.ts` 已在 `runtimeState=running` 时按节流发送 typing

#### remove
- `src/daemon.ts` remove handler 已：
  - 拒绝 `attached / attach_pending / takeover_pending`
  - 在有 `imWorkerPid` 时先 `terminate(name)`
  - 再 `registry.remove(name)`
- 集成测试已覆盖相关语义

#### keepalive
- `src/plugins/im/mattermost.ts` 已具备：
  - `_lastHeartbeatSeq`
  - heartbeat seq/ack 关联
  - timeout 后主动 close + reconnect
  - `getConnectionHealth()`
- 这意味着最小必要的逻辑活性检测已经具备

---

## 2. 当前文档状态 review

### 已对齐到当前真值的文档
以下文档目前基本可视为同步到当前真值：
- `docs/SPEC.md`
- `docs/TODO.md`
- `docs/RESEARCH.mattermost-typing-semantics.md`
- `docs/REVIEW.phase2-and-current-state.md`
- `docs/CURRENT-ISSUES.typing-and-remove.md`
- `docs/DELIVERY-SUMMARY.resident-worker-phase2-final-check.md`
- `docs/IMPL-SLICES.phase3-future-features.md`

### 仍需注意的文档
#### `docs/MATTERMOST-GAPS.md`
用户已更新该文件为“单一真值结构”，从当前内容看：
- 结构已比之前干净很多
- 但仍需未来 agent 注意持续维护，不要重新把已关闭项和活跃 gap 混写

#### `docs/AGENT-INSTRUCTIONS.phase1-current-fixes.md`
#### `docs/AGENT-INSTRUCTIONS.phase3-docs-and-channel-strategy.md`
这两份文档的目标已经基本达成，建议：
- 保留 archive 版本作为历史记录
- 工作副本后续可删除或在 README/docs 入口中降权，不再作为主执行入口

---

## 3. 现在还剩哪些“未完成项”

### 不再属于 phase2 阻塞项
以下事项现在不再阻塞 phase3：
1. typing 路径真值
2. remove 资源清理闭环
3. keepalive 最小必要补强

### 当前剩余项，属于 phase3 或后续增强
1. **Mattermost 健康摘要接入 daemon diagnose/status/TUI**
2. **独立 `mattermost-ws-resilience` 测试组**
3. **CLI tab 补全**
4. **TUI 扩展**
5. **Mattermost thread/channel 空间策略实现**

---

## 4. 是否应该现在进入 `docs/AGENT-INSTRUCTIONS.phase2-phase3-features.md`？

### 结论
**是的，现在应该进入 `docs/AGENT-INSTRUCTIONS.phase2-phase3-features.md`。**

原因：
- phase2-final 里原本阻塞的 typing 真值问题已完成
- 文档总体已经收口到单一真值
- 当前剩余项已经清晰地落入 phase3 范围

---

## 5. 推荐后续顺序

### 第一优先级
1. CLI tab 补全

### 第二优先级
2. TUI 扩展

### 第三优先级
3. Mattermost 会话空间策略（thread / channel）

说明：
- 这与 `docs/IMPL-SLICES.phase3-future-features.md` 保持一致
- channel 策略虽然已经完成产品约束收敛，但仍然是高影响功能，放在最后最合理

---

## 6. 建议给下游 Claude Code agent 的执行入口

### 现在主入口
- `docs/AGENT-INSTRUCTIONS.phase2-phase3-features.md`

### 辅助文档
- `docs/IMPL-SLICES.phase3-future-features.md`
- `docs/SPEC.md`
- `docs/TODO.md`
- `docs/STATE-INVARIANTS.md`
- `docs/EVENT-SEMANTICS.md`
- `docs/REVIEW.phase2-and-current-state.md`

### 历史/归档参考
- `docs/REVIEW.phase2-and-current-issues.md`
- `docs/CURRENT-ISSUES.typing-and-remove.md`
- `docs/archive/AGENT-INSTRUCTIONS.phase1-current-fixes.archive.md`
- `docs/archive/AGENT-INSTRUCTIONS.phase3-docs-and-channel-strategy.archive.md`

---

## 7. 给你的建议

如果你现在要继续交给下游 agent，我建议不要再让它先跑 phase2-final，而是直接进入：
- `docs/AGENT-INSTRUCTIONS.phase2-phase3-features.md`

如果你想降低误用成本，可以让它在开始前额外阅读：
- `docs/REVIEW.phase2-and-current-state.md`

这样它会知道：
- phase2 为什么算收口
- 当前 channel 策略的产品约束是什么
- 哪些历史文档只是归档，不是当前真值
