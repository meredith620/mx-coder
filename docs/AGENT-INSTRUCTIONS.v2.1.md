# 给下游 Claude Code agent 的执行指令（v2.1）

你现在接手的是 mx-coder 的 **v2.1 新需求开发**，范围只包含：

1. IM 原生命令穿透（`//<cmd>`）
2. `mx-coder setup systemd` 命令

不要把这轮工作扩展成新的大版本重构。

## 主入口

先读：
1. `docs/IMPL-SLICES.v2.1.md`
2. `docs/SPEC.md`
3. `docs/TODO.md`
4. `docs/DEV-OPS.md`

然后读代码：
- `src/daemon.ts`
- `src/im-message-dispatcher.ts`
- `src/im-worker-manager.ts`
- `src/approval-handler.ts`
- `src/acl-manager.ts`
- `src/restore-action.ts`
- `src/persistence.ts`
- `src/plugins/im/mattermost.ts`
- `src/session-registry.ts`
- `src/cli-parser.ts`
- `src/index.ts`
- `src/types.ts`

如果做到 systemd，再读：
- `README.md`
- `docs/DEV-OPS.md`

---

## 固定执行顺序

严格按 `docs/IMPL-SLICES.v2.1.md` 顺序推进：

1. V1 原生命令穿透协议与路由基线
2. V2 原生命令穿透权限 / 审计 / 恢复闭环
3. V3 systemd service 文件生成与 dry-run 基线
4. V4 systemd install / status / uninstall 闭环
5. V5 文档与运维指引收口

注意：`不得跳序` 是指**同一子链内部**不得跳序。passthrough 子链（V1→V2）与 systemd 子链（V3→V4→V5）没有强制跨链依赖；若任务编排允许，可独立安排。

---

## 强约束

1. 必须按 TDD 执行：先失败测试，再最小实现。
2. 单斜杠 `/` 命令优先级永远高于 `//` passthrough。
3. passthrough 不得绕过 ACL / 审批 / 审计 / 恢复约束。
4. systemd 只允许实现 **user service**，不得动 system-level service。
5. 在没有完成实现前，不要把文档写成“命令已经可用”。
6. 若真实宿主环境不可控，优先做 dry-run / mockable shell 封装，不要为了跑通测试而牺牲设计边界。
7. 若某个 v2.1 切片依赖主线稳定化中的 ACL / 恢复真值，而当前分支尚未具备该前置条件，必须把它显式当作 blocker 回报，不能私自绕开。

---

## 每个切片的执行流程

对每个切片，都必须：
1. 先确认前置 slice 已完成。
2. 先新增或修改失败测试。
3. 再写最小实现。
4. 运行当前 slice 对应测试。
5. 测试通过后再进入下一 slice。

---

## 每次汇报格式

每次汇报必须包含：

- 已读文档：
- 当前切片：
- 新增/修改测试：
- 修改实现文件：
- 当前测试结果：
- 是否发现设计冲突：
- 下一步计划：

---

## 开始时的首条回复格式

请先只回复：

- 已读文档：
- 当前切片：
- 预期风险：

然后立刻开始当前 slice。