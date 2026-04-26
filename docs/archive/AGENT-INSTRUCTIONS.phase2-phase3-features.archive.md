# 给下游 Claude Code agent 的执行指令（阶段 2：phase3 功能开发）

你现在接手 mx-coder (Multi-modal Coder) 的**阶段 2：phase3 功能开发**工作。你运行在 Claude Code CLI 中，请严格遵循既定设计与排期，不要重新发散架构。

## 你的目标

在当前问题修复完成之后，继续推进 phase3 功能，顺序固定为：

1. **CLI tab 补全**
2. **TUI 扩展**
3. **Mattermost 会话空间策略（thread / channel）**

注意：
- Mattermost 不再是“用 channel 直接替代 thread”
- 新需求已经定为：
  - 默认 `spaceStrategy=thread`
  - 持久配置决定全局默认策略
  - CLI / TUI 支持单次 override
  - 只影响未来新建的 session
  - 已存在 session 不迁移
  - 当前仅对 Mattermost 生效

## 你必须先阅读的文档（按顺序）

1. `docs/IMPL-SLICES.phase3-future-features.md`
2. `docs/SPEC.md`
3. `docs/TODO.md`
4. `docs/STATE-INVARIANTS.md`
5. `docs/EVENT-SEMANTICS.md`
6. `docs/archive/IMPL-SLICES.resident-worker-tdd.archive.md`

若需要了解当前主链与问题修复背景，再读：
7. `docs/archive/REVIEW.phase2-and-current-issues.archive.md`
8. `docs/archive/CURRENT-ISSUES.typing-and-remove.archive.md`
9. `docs/MATTERMOST-GAPS.md`

然后再读这些代码：
10. `src/index.ts`
11. `src/cli-parser.ts`
12. `src/daemon.ts`
13. `src/tui.ts`
14. `src/ipc/client.ts`
15. `src/plugins/im/mattermost.ts`
16. `src/session-registry.ts`
17. `src/types.ts`
18. `src/persistence.ts`

---

## 强约束

1. 必须按 TDD 执行：先测试，后实现
2. 不要跳切片，不要并行推进多个大功能
3. 不要把 channel 策略直接做成 thread 的硬替代
4. 不要让“修改默认策略”影响既有 session
5. 不要把 CLI tab 补全做成一次大规模 CLI 重写
6. 不要把 TUI 做成 Claude REPL；attach 仍然走原生终端 Claude
7. 若涉及 Mattermost 策略，记住：
   - 默认 `thread`
   - `channel` 只是可选模式
   - 当前仅对 Mattermost 生效

---

## 固定执行顺序

### 第一组：CLI tab 补全
按 `docs/IMPL-SLICES.phase3-future-features.md` 中执行：
- T1
- T2
- T3

目标：
- bash / zsh completion
- 静态子命令补全
- 动态 session 名补全
- 文档安装说明

---

### 第二组：TUI 扩展
按文档中执行：
- U1
- U2
- U3
- U4

目标：
- 订阅 daemon 状态
- 只读总览面板
- 尽可能多的 session 管理动作（除 attach 外）
- 显示 runtimeState / queue / approval / worker 健康摘要

---

### 第三组：Mattermost 会话空间策略（thread / channel）
按文档中执行：
- C1
- C2
- C3
- C4

这里要特别遵守以下产品约束：

#### 真值约束
1. 默认 `spaceStrategy=thread`
2. 全局默认值来自**持久配置文件**
3. CLI / TUI 的单次创建或 open 动作可 override 全局默认策略
4. 单次 override **只影响本次创建**，不回写配置文件
5. 修改默认策略后，只影响**未来新建 session**
6. 已存在 session 的绑定空间保持不变，不迁移
7. 所有新 session 创建入口都受该策略控制：
   - CLI 创建
   - TUI 创建
   - IM `/open`
   - IM 普通文本自动建 session
8. `/status`、IM `/status`、TUI 都要显示：
   - 当前默认策略
   - 当前 session 的实际绑定空间类型

#### Mattermost 范围约束
- `spaceStrategy` 当前仅对 Mattermost 生效
- 为未来 Discord 等插件保留扩展点，但不要提前做过度泛化

---

## 每个切片执行流程

对每个切片，都必须严格执行：
1. 确认前置依赖已完成
2. 先写失败测试
3. 再写最小实现
4. 运行该切片对应测试
5. 测试通过后再汇报并进入下一切片

---

## 每次汇报必须包含

请严格按这个格式汇报：

- 已读文档：
- 当前切片：
- 新增/修改测试：
- 修改实现文件：
- 当前测试结果：
- 是否发现设计冲突：
- 下一步计划：

---

## 开始前的第一条回复格式

请先回复一段很短的启动说明，格式固定：

- 已读文档：
- 当前切片：
- 预期风险：

然后立刻开始 TDD 实施。
