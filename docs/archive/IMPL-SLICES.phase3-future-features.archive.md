# mx-coder (Multi-modal Coder) 后续功能规划与 TDD 切片（phase3 候选）

> **文档生命周期**：这是“resident worker 主架构收口后”的后续功能规划文档。它不是长期不可变的规格文档，而是下一阶段功能排期与实施切片的执行入口。  
> 当以下任一前提发生变化时，需要更新本文件：
> 1. resident worker 主架构尚未稳定；
> 2. CLI 命令面发生明显变化；
> 3. Mattermost thread/channel 路由模型改变；
> 4. TUI 目标从监控台演变为更强控制台。  
> 若某项功能决定不做，或已被实现并并入主 IMPL-SLICES，应删除或归档相应小节，避免未来 agent 继续沿用过时排期。

---

## 1. 目标

本文覆盖以下 3 个后续功能方向：

1. 为 Mattermost 提供**可配置的会话空间策略**：`thread`（默认）或 `channel`
2. 为 mx-coder CLI 增加 **tab 补全**
3. 实现并扩展 **TUI**，覆盖尽可能多的 session 管理能力

本文输出：
- 合理性分析
- 可行性分析
- 推荐实施阶段
- 详细 TDD slices 计划

---

## 2. 总体排期建议

### 建议顺序

**第一优先级：CLI tab 补全**
- 原因：边界小、风险低、收益直接
- 不依赖 Mattermost 架构变化
- 不会扰动 resident worker 主链

**第二优先级：TUI 扩展**
- 原因：建立在稳定的 `status/runtimeState` 和 daemon IPC 真值之上
- 能显著提升本地可观测性和 session 管理效率
- 但需要 resident worker、busy/idle、remove 等问题先收口

**第三优先级：channel 替代 thread**
- 原因：这是产品模型级变更，不只是实现细节变更
- 会显著影响路由、ACL、配置、打开会话、通知模型、清理策略
- 不应在当前 resident worker 稳定前推进

### 阶段建议

- **Phase 3A：体验增强（低风险）**
  - CLI tab 补全
- **Phase 3B：控制台能力建设**
  - TUI session 管理
- **Phase 3C：IM 路由模型探索（高影响）**
  - channel 模型 spike + 决策
  - 决策通过后再实现

---

## 3. 功能 1：Mattermost 会话空间策略（thread / channel）

## 3.1 是否合理

### 产品约束（已确认）
- 默认模式为 `thread`
- 通过**持久配置**切换默认策略
- CLI / TUI 支持**单次 override**，仅影响本次创建，不回写全局默认值
- 切换后**只影响未来新建的 session**
- 已存在 session 保持原绑定方式，不迁移
- 该策略当前**仅对 Mattermost 生效**
- 所有新 session 创建入口都受该策略控制：
  - CLI 创建
  - TUI 创建
  - IM `/open`
  - IM 普通文本自动创建 session
- `/status`、IM `/status`、未来 TUI 中都要显示：
  - 当前默认 `spaceStrategy`
  - 当前 session 实际绑定空间类型

### 合理性优点
1. **保留 thread 默认路径，兼顾稳定性与扩展性**
   - 不强制替换当前模型
2. **允许 channel 作为可选更强隔离模式**
   - 适合长期、独立、高隔离 session
3. **符合“切换只影响未来新建 session”的低风险原则**
   - 避免旧 session 迁移成本与不确定性
4. **CLI / TUI 单次 override 更灵活**
   - 便于试验 channel 模式而不污染全局默认配置

### 合理性缺点
1. **会话空间策略会进入配置、路由、展示层**
   - 系统复杂度上升
2. **channel 模式仍有 sidebar 膨胀与权限要求问题**
3. **需要同时支持“默认值”和“单次 override”两套入口语义**
4. **不同 IM 插件未来可能有不同策略能力，抽象必须可扩展但不能过早泛化**

### 结论
**合理，而且比“直接用 channel 替代 thread”更稳。**  
推荐做法是：
- 对 Mattermost 引入 `spaceStrategy = thread | channel`
- `thread` 保持默认
- `channel` 作为可选模式，不是对 thread 的立即替代
- `channel` 模式默认创建 **private channel**
- 主 channel 作为统一索引入口保留
- 设计上明确区分：
  - **默认值（持久配置）**
  - **单次创建 override（CLI/TUI）**

---

## 3.2 可行性分析

### 当前缺口
在新的产品约束下，channel 模式不再是“替代 thread”，而是 Mattermost 的**可选会话空间策略**。因此缺口变为：
- 持久配置支持 `spaceStrategy=thread|channel`
- CLI / TUI 单次创建 override 支持
- session binding 需要记录“实际空间类型”
- `/open`、自动建 session、`/status`、`/list`、未来 TUI 都要感知当前默认策略与 session 实际绑定策略
- 当 `spaceStrategy=channel` 时，需要 `teamId` 与创建 private channel 权限
- channel 模式应保留主 channel 作为索引入口，而不是让 session channel 脱离统一入口
- channel 模式的清理默认应优先考虑 archive/解绑，而不是直接硬删除
- channel 模式不是替代 thread，而是 Mattermost 的可选会话空间策略

### 技术难点
1. **session 绑定模型要扩展**
   - 当前绑定是 threadId
   - 未来可能要支持 `bindingKind = thread | channel`
2. **IM 路由入口要重写一部分**
   - 现在的 `getByIMThread()` 不够
   - 需要更通用的 `getByIMConversation(plugin, binding)`
3. **配置要变化**
   - Mattermost config 需要 teamId 等字段
4. **/open 行为会改变**
   - 创建 thread vs 创建新 channel 的用户反馈完全不同
5. **ACL / 可见性 / 清理策略要重新设计**

### 实施建议
**不需要再做“是否支持 channel”的基础技术 spike，技术上已经可行；现在需要做的是“策略化落地”。**
必须先明确并实现：
- 全局默认 `spaceStrategy`
- 单次 override
- session 绑定的空间类型持久化
- `/open` 与自动建 session 在两种模式下的行为一致性

### 阶段建议
- **可以进入实现，但应先做策略抽象与配置落地，再做 channel 创建路径**
- 建议放在 **Phase 3C**，在 CLI 补全与 TUI 之后推进

---

## 3.3 功能 1 的 TDD slices（以“先 spike 再实现”为前提）

### C1 — 会话空间策略抽象与持久化
**状态**：已完成
**目标**：让 thread/channel 成为 Mattermost 的显式创建策略，并记录每个 session 的实际空间类型。  
**依赖**：resident worker 主链稳定

**先写测试**
- `tests/unit/im-binding-strategy.test.ts`
- `tests/integration/persistence.test.ts`

**测试关注点**
- session binding 可表达 `thread` 和 `channel` 两类目标
- session 持久化后能保留其实际绑定空间类型
- 修改默认 `spaceStrategy` 不影响既有 session

**后写实现**
- `src/types.ts`
- `src/session-registry.ts`
- `src/persistence.ts`
- 必要时引入新的 binding 类型

**提交建议**
- `refactor(im): add persistent conversation space strategy for mattermost sessions`

---

### C2 — Mattermost 默认配置与单次 override
**状态**：部分完成（当前已完成持久配置 `spaceStrategy` / `teamId` 校验；CLI/TUI 单次 override 仍待补）
**目标**：支持持久配置 `spaceStrategy`，并支持 CLI/TUI 单次 override。  
**依赖**：C1

**先写测试**
- `tests/unit/mattermost-plugin.test.ts`
- `tests/unit/cli-parser.test.ts`
- 视需要新增 `tests/integration/cli-space-strategy.test.ts`

**测试关注点**
- config 支持 `spaceStrategy=thread|channel`
- `channel` 模式缺 `teamId` 时给出明确错误
- `channel` 模式默认创建 private channel
- CLI / TUI 的单次 create/open 可 override 全局默认策略
- override 不回写配置文件

**后写实现**
- `src/plugins/im/mattermost.ts`
- `src/index.ts`
- `src/cli-parser.ts`
- 后续 TUI 入口

**提交建议**
- `feat(mattermost): support configurable default and per-action override for space strategy`

---

### C3 — `/open` 与 IM 自动建 session 支持两种策略
**状态**：已完成（当前范围）
**目标**：在 thread/channel 两种模式下，`/open` 和普通文本自动建 session 都遵循当前策略。  
**依赖**：C2

**先写测试**
- `tests/integration/im-routing.test.ts`
- `tests/unit/mattermost-plugin.test.ts`

**测试关注点**
- `/open <name>` 在 thread 模式下创建/定位 thread
- `/open <name>` 在 channel 模式下通过主 channel 索引入口创建/定位独立 private channel
- 普通文本自动建 `im-*` session 时也遵循当前策略
- `/status` 与 `/list` 能显示默认策略与 session 实际空间类型
- 主 channel 仍可作为统一入口执行 `/open`、`/list`、`/status`

**后写实现**
- `src/daemon.ts`
- `src/plugins/im/mattermost.ts`
- 相关状态渲染代码

**提交建议**
- `feat(im): route open and auto-created sessions by configured mattermost space strategy`

---

### C4 — channel 模式资源清理与展示闭环
**状态**：已完成（当前范围）
**目标**：channel 模式下 remove/archive/status/TUI 展示都能正确反映和处理会话空间。  
**依赖**：C3

**先写测试**
- `tests/integration/daemon-commands.test.ts`
- `tests/unit/tui-renderer.test.ts`
- `tests/unit/mattermost-plugin.test.ts`

**测试关注点**
- remove session 时 channel 资源默认走 archive/解绑语义，而不是直接硬删除
- attached session 的 remove 策略明确
- status / IM `/status` / TUI 能显示默认策略和 session 实际空间类型
- channel 模式下主 channel 作为索引入口的状态展示不丢失

**后写实现**
- `src/daemon.ts`
- `src/plugins/im/mattermost.ts`
- `src/tui.ts`

**提交建议**
- `feat(im): complete cleanup and presentation flow for mattermost thread-channel strategy`


---

## 4. 功能 2：CLI tab 补全

## 4.1 是否合理

### 结论
**非常合理，而且应该优先做。**

原因：
- 用户收益直接
- 风险低
- 不需要大幅改 resident worker 核心
- 与 session 管理命令强相关，命令集已经稳定到一定程度

## 4.2 可行性分析

### 当前状态
- 现在 CLI 是自定义解析器（`src/cli-parser.ts`）
- 没有 shell completion 方案
- 也没有内置交互式 readline CLI

### 当前状态
- CLI completion 已完成：
  - T1 `completion bash|zsh`
  - T2 `completion sessions` 动态 session 名补全
  - T3 README / DEV-OPS 安装说明
- TUI 扩展已完成：
  - U1 订阅客户端与本地 state store
  - U2 只读总览面板
  - U3 交互式 session 管理动作（除 attach）
  - U4 busy/idle 与连接健康摘要渲染
- Mattermost `spaceStrategy` 已完成当前规划范围实现：
  - C1 bindingKind 持久化
  - C2 Mattermost 配置 `spaceStrategy` / `teamId`
  - C3 `/open` 与自动建 session 按策略路由
  - C4 status / TUI 展示与 channel 绑定清理闭环
- 已完成全量回归：`npm test` 通过，`npm run build` 通过

### 推荐方案
不要发明自己的 shell 解析补全协议。优先考虑：

1. **静态子命令补全**
   - `create / attach / list / status / remove / import / takeover-status / takeover-cancel / im ...`
2. **动态 session 名补全**
   - 对 `attach <name>` / `remove <name>` / `status <name>` 等命令，从 daemon `list/status` 读取 session 名
3. **生成 shell completion 脚本**
   - bash / zsh 优先

### 不建议的方向
- 不建议自己造完整 readline 交互壳来模拟 shell tab 补全
- 不建议在当前阶段引入过重 CLI 框架，只为了补全而重写命令系统

### 阶段建议
- **应放在 Phase 3A**
- 可以在 resident worker 稳定之后尽快做

---

## 4.3 功能 2 的 TDD slices

### T1 — completion 子命令与静态补全骨架
**状态**：已完成
**目标**：CLI 能输出 shell completion 所需元信息。  
**依赖**：当前 CLI 命令面稳定

**先写测试**
- `tests/unit/cli-parser.test.ts`
- `tests/e2e/cli-e2e.test.ts`

**测试关注点**
- `mx-coder completion bash`
- `mx-coder completion zsh`
- 输出包含所有已知子命令

**后写实现**
- `src/index.ts`
- `src/cli-parser.ts`

**提交建议**
- `feat(cli): add shell completion entrypoint`

---

### T2 — 动态 session 名补全
**状态**：已完成
**目标**：补全 attach/remove/status 等命令的 session 名。  
**依赖**：T1

**先写测试**
- `tests/integration/cli-completion.test.ts`

**测试关注点**
- 已存在 session 时，completion 输出对应名字
- 无 session 时输出为空但不报错

**后写实现**
- `src/index.ts`
- IPC client 读取 session 列表

**提交建议**
- `feat(cli): complete session names dynamically from daemon state`

---

### T3 — 文档与安装指引
**状态**：已完成
**目标**：README / DEV-OPS 提供 shell completion 安装说明。  
**依赖**：T2

**提交建议**
- `docs(cli): document shell completion setup for bash and zsh`

---

## 5. 功能 3：TUI 扩展

## 5.1 是否合理

### 结论
**非常合理，但必须建立在状态模型和 daemon 命令闭环已经稳定的前提上。**

TUI 不该只是“看状态”，而应尽量覆盖除了 attach 外的大多数 session 管理能力。这和你的方向一致。

## 5.2 可行性分析

### 当前状态
- `index.ts` 中 `tui` 仍是未实现
- 已有 TUI 渲染测试骨架，但没有真正可用的 TUI 应用
- daemon 已有较多命令，适合成为 TUI 的操作后端

### 建议定位
TUI 应定位为：
- **监控 + 管理控制台**
- **不是 Claude 交互宿主**
- attach 仍应跳到原生终端 Claude

### 建议纳入的能力
除了 attach 外，优先支持：
- list / status
- create
- remove
- diagnose
- takeover-status
- takeover-cancel
- import
- 查看 runtimeState / queue length / approval 状态 / connection health
- 若后续 ACL 成熟，可展示 owner/operator/approver 相关信息

### 不建议一开始就做的
- 不要第一版就做复杂键盘驱动工作流编排
- 不要把 TUI 变成 Claude REPL

### 阶段建议
- **Phase 3B**
- 在 CLI completion 之后做更合适

---

## 5.3 功能 3 的 TDD slices

### U1 — TUI 数据模型与订阅客户端
**状态**：已完成
**目标**：TUI 能连接 daemon，订阅状态，并维护本地 session 视图。  
**依赖**：resident worker 状态语义稳定

**先写测试**
- `tests/unit/tui-renderer.test.ts`
- `tests/integration/ipc-subscribe.test.ts`

**测试关注点**
- 能接收 `session_state_changed`
- 能维护本地 session 列表快照
- 能显示 runtimeState / queue / approval / worker 健康摘要

**后写实现**
- `src/tui.ts`
- `src/ipc/client.ts`（如需增强）

**提交建议**
- `feat(tui): add daemon subscription client and local session state store`

---

### U2 — TUI 只读面板
**状态**：已完成
**目标**：先把总览面板做稳。  
**依赖**：U1

**先写测试**
- `tests/unit/tui-renderer.test.ts`

**测试关注点**
- 渲染 session 名称
- 渲染 `status + runtimeState`
- 渲染 queue length
- 渲染 approval / recovering / attached 等高亮状态

**后写实现**
- `src/tui.ts`

**提交建议**
- `feat(tui): render session overview with runtime and queue states`

---

### U3 — TUI 交互式 session 管理动作
**状态**：已完成
**目标**：支持除 attach 外尽可能多的 CLI session 管理能力。  
**依赖**：U2

**先写测试**
- `tests/integration/tui-actions.test.ts`

**测试关注点**
- create
- remove
- status
- diagnose
- takeover-status
- takeover-cancel
- import

**后写实现**
- `src/tui.ts`
- 复用已有 IPC 命令，不自己重复造轮子

**提交建议**
- `feat(tui): support interactive session management actions except attach`

---

### U4 — TUI 可观测性增强
**状态**：已完成
**目标**：把 resident worker 时代的重要状态都暴露出来。  
**依赖**：U3

**先写测试**
- `tests/unit/tui-renderer.test.ts`

**测试关注点**
- 显示 busy/idle 派生
- 显示 Mattermost connection health
- 显示 lastTurnOutcome / interruptReason（若实现）

**提交建议**
- `feat(tui): expose worker health and busy-idle diagnostics`

---

## 6. 推荐最终阶段排期

### 近期（推荐）
- 先做当前问题修复：typing / remove / WS 健壮性剩余项
- 然后进入：**CLI tab 补全**

### 中期（推荐）
- 做 **TUI 扩展**

### 远期（先 spike）
- 做 **channel 模式探索**
- 只有在产品模型确认后，才进入实现

---

## 7. 给后续 AI agent 的执行建议

如果下一位 agent 接手 phase3，建议执行顺序是：

1. 先阅读：
   - `docs/REVIEW.phase2-and-current-issues.md`
   - `docs/CURRENT-ISSUES.typing-and-remove.md`
   - 本文档
   - `docs/IMPL-SLICES.resident-worker-tdd.md`

2. 完成当前问题修复后，再开新功能：
   - 先 `CLI tab completion`
   - 再 `TUI`
   - 最后 `channel spike`

3. 对 channel 功能，必须先做 spike / 产品决策，不要直接进入实现
